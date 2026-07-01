"use client";

import { useState } from "react";
import PropTypes from "prop-types";
import { Button } from "@/shared/components";
import { getProviderCustomModelRows } from "@/shared/utils/providerCustomModels";
import ModelRow from "./ModelRow";

export default function CompatibleModelsSection({
  providerStorageAlias,
  providerDisplayAlias,
  providerId,
  modelAliases,
  customModels,
  syncedModels,
  copied,
  onCopy,
  onDeleteAlias,
  onAddCustomModel,
  onDeleteCustomModel,
  onDisableModel,
  onEnableModel,
  onEnableAll,
  onDisableAll,
  disabledModelIds = [],
  connections,
  isAnthropic,
  getCaps,
  modelTestResults = {},
  testingModelIds,
  onTestModel,
  onShowAddModal,
}) {
  const [importing, setImporting] = useState(false);

  // Build the full model list: custom + legacy aliases + synced (deduped by id).
  const allModels = getProviderCustomModelRows({
    customModels,
    modelAliases,
    providerAlias: providerStorageAlias,
    type: "llm",
  });
  const existingIds = new Set(allModels.map((model) => model.id));
  for (const model of syncedModels || []) {
    const rawId = model?.id || model?.name || model?.model;
    if (typeof rawId !== "string" || !rawId.trim()) continue;
    const id = rawId.trim();
    if (existingIds.has(id)) continue;
    allModels.push({
      id,
      name: model?.name || model?.displayName || model?.display_name || id,
      fullModel: `${providerStorageAlias}/${id}`,
      alias: null,
      source: "synced",
    });
    existingIds.add(id);
  }

  const byId = (a, b) => String(a.id).localeCompare(String(b.id), undefined, { numeric: true, sensitivity: "base" });
  const disabledSet = new Set(disabledModelIds);
  const displayModels = allModels.filter((model) => !disabledSet.has(model.id)).sort(byId);
  const disabledDisplayModels = allModels.filter((model) => disabledSet.has(model.id)).sort(byId);
  const activeIds = allModels.map((model) => model.id).filter((id) => !disabledSet.has(id));

  const handleImport = async () => {
    if (importing) return;
    const activeConnection = connections.find((conn) => conn.isActive !== false);
    if (!activeConnection) return;

    setImporting(true);
    try {
      const res = await fetch(`/api/providers/${activeConnection.id}/models`);
      const data = await res.json();
      if (!res.ok) {
        alert(data.error || "Failed to import models");
        return;
      }
      const models = data.models || [];
      if (models.length === 0) {
        alert("No models returned from /models.");
        return;
      }
      let importedCount = 0;
      for (const model of models) {
        const modelId = model.id || model.name || model.model;
        if (!modelId) continue;
        if (allModels.some((entry) => entry.id === modelId)) continue;
        await onAddCustomModel(modelId);
        importedCount += 1;
      }
      if (importedCount === 0) {
        alert("No new models were added.");
      }
    } catch (error) {
      console.log("Error importing models:", error);
    } finally {
      setImporting(false);
    }
  };

  const canImport = connections.some((conn) => conn.isActive !== false);
  const hasConnections = connections.length > 0;

  const renderModelRow = (model) => {
    const isSynced = model.source === "synced";
    return (
      <ModelRow
        key={`${model.source}-${providerStorageAlias}/${model.id}`}
        model={{ id: model.id, name: model.name }}
        fullModel={`${providerDisplayAlias}/${model.id}`}
        alias={model.alias}
        copied={copied}
        onCopy={onCopy}
        testStatus={modelTestResults[model.id]}
        onTest={hasConnections ? () => onTestModel(model.id) : undefined}
        isTesting={testingModelIds && testingModelIds.has(model.id)}
        isCustom={!isSynced}
        isFree={false}
        onDeleteAlias={
          isSynced
            ? undefined
            : model.source === "custom"
              ? () => onDeleteCustomModel(model.id)
              : () => onDeleteAlias(model.alias)
        }
        onDisable={isSynced ? () => onDisableModel(model.id) : undefined}
        caps={getCaps ? getCaps(`${providerId}/${model.id}`) : undefined}
      />
    );
  };

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-text-muted">
        Add {isAnthropic ? "Anthropic" : "OpenAI"}-compatible models manually or import them from the /models endpoint.
      </p>

      <div className="flex items-center gap-2 flex-wrap">
        <Button size="sm" icon="add" onClick={onShowAddModal}>
          Add Model
        </Button>
        <Button size="sm" variant="secondary" icon="download" onClick={handleImport} disabled={!canImport || importing}>
          {importing ? "Importing..." : "Import from /models"}
        </Button>
        {disabledModelIds.length > 0 && (
          <Button size="sm" variant="secondary" icon="restart_alt" onClick={onEnableAll}>
            Active All
          </Button>
        )}
        {activeIds.length > 0 && (
          <Button size="sm" variant="secondary" icon="block" onClick={() => onDisableAll(activeIds)}>
            Disable All
          </Button>
        )}
      </div>

      {!canImport && (
        <p className="text-xs text-text-muted">
          Add a connection to enable importing models.
        </p>
      )}

      {displayModels.length > 0 ? (
        <div className="flex flex-wrap gap-3">
          {displayModels.map((model) => renderModelRow(model, false))}
        </div>
      ) : (
        <p className="text-xs text-text-muted italic">No models added yet. Use “Add Model” or “Import from /models”.</p>
      )}

      {disabledDisplayModels.length > 0 && (
        <div className="w-full mt-2">
          <p className="text-xs text-text-muted mb-2">Unavailable models ({disabledDisplayModels.length}):</p>
          <div className="flex flex-wrap gap-2">
            {disabledDisplayModels.map((model) => (
              <button
                key={`disabled-${model.source}-${model.id}`}
                onClick={() => onEnableModel(model.id)}
                className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-dashed border-black/10 bg-black/[0.02] text-xs text-text-muted opacity-60 transition-colors hover:text-primary hover:border-primary/40 hover:bg-primary/5 hover:opacity-100 dark:border-white/10 dark:bg-white/[0.03]"
                title="Restore model to the active list"
              >
                <span className="material-symbols-outlined text-[13px]">add_circle</span>
                {model.id}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

CompatibleModelsSection.propTypes = {
  providerStorageAlias: PropTypes.string.isRequired,
  providerDisplayAlias: PropTypes.string.isRequired,
  providerId: PropTypes.string.isRequired,
  modelAliases: PropTypes.object.isRequired,
  customModels: PropTypes.arrayOf(PropTypes.object),
  syncedModels: PropTypes.arrayOf(PropTypes.object),
  copied: PropTypes.string,
  onCopy: PropTypes.func.isRequired,
  onDeleteAlias: PropTypes.func.isRequired,
  onAddCustomModel: PropTypes.func.isRequired,
  onDeleteCustomModel: PropTypes.func.isRequired,
  onDisableModel: PropTypes.func,
  onEnableModel: PropTypes.func,
  onEnableAll: PropTypes.func,
  onDisableAll: PropTypes.func,
  disabledModelIds: PropTypes.arrayOf(PropTypes.string),
  connections: PropTypes.arrayOf(PropTypes.shape({
    id: PropTypes.string,
    isActive: PropTypes.bool,
  })).isRequired,
  isAnthropic: PropTypes.bool,
  getCaps: PropTypes.func,
  modelTestResults: PropTypes.object,
  testingModelIds: PropTypes.object,
  onTestModel: PropTypes.func,
  onShowAddModal: PropTypes.func,
};
