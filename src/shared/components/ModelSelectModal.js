"use client";

import { useState, useMemo, useEffect, useRef } from "react";
import PropTypes from "prop-types";
import Modal from "./Modal";
import Button from "./Button";
import ProviderIcon from "./ProviderIcon";
import CapacityBadges from "./CapacityBadges";
import { useModelCaps } from "@/shared/hooks/useModelCaps";
import { getModelsByProviderId, getModelKind } from "@/shared/constants/models";
import { OAUTH_PROVIDERS, APIKEY_PROVIDERS, FREE_PROVIDERS, FREE_TIER_PROVIDERS, AI_PROVIDERS, isOpenAICompatibleProvider, isAnthropicCompatibleProvider, getProviderAlias } from "@/shared/constants/providers";

// Provider order: OAuth first, then Free Tier, then API Key (matches dashboard/providers)
const PROVIDER_ORDER = [
  ...Object.keys(OAUTH_PROVIDERS),
  ...Object.keys(FREE_PROVIDERS),
  ...Object.keys(FREE_TIER_PROVIDERS),
  ...Object.keys(APIKEY_PROVIDERS),
];

// Providers that need no auth — always show in model selector
const NO_AUTH_PROVIDER_IDS = Object.keys(FREE_PROVIDERS).filter(id => FREE_PROVIDERS[id].noAuth);
const MODEL_TEST_SESSION_KEY = "9router:model-select-test-session:v1";
const TERMINAL_TEST_STATES = new Set(["ok", "failed"]);

function loadStoredTestSession() {
  if (typeof window === "undefined") return null;

  try {
    const raw = window.localStorage.getItem(MODEL_TEST_SESSION_KEY);
    if (!raw) return null;

    const stored = JSON.parse(raw);
    const results = {};
    Object.entries(stored.results || {}).forEach(([value, result]) => {
      if (!result || typeof result !== "object") return;
      const staleRunning = result.state === "running" || result.state === "queued";
      results[value] = {
        ...result,
        state: staleRunning ? "stopped" : result.state,
      };
    });

    return {
      results,
      progress: {
        done: Number(stored.progress?.done) || 0,
        total: Number(stored.progress?.total) || 0,
      },
    };
  } catch {
    return null;
  }
}

function countFinishedResults(models, results) {
  return models.filter((model) => TERMINAL_TEST_STATES.has(results[model.value]?.state)).length;
}

function isFreePassedModel(model) {
  if (!model) return false;
  const providerId = model.providerId;
  const provider = AI_PROVIDERS[providerId];
  const searchable = `${model.value || ""} ${model.id || ""} ${model.name || ""}`.toLowerCase();

  return Boolean(
    FREE_PROVIDERS[providerId] ||
    FREE_TIER_PROVIDERS[providerId] ||
    provider?.hasFree ||
    searchable.includes(":free") ||
    searchable.includes(" free")
  );
}

export default function ModelSelectModal({
  isOpen,
  onClose,
  onSelect,
  onDeselect,
  selectedModel,
  activeProviders = [],
  title = "Select Model",
  modelAliases = {},
  kindFilter = null,
  addedModelValues = [],
  closeOnSelect = true,
  enableModelTesting = false,
}) {
  // Filter activeProviders by serviceKinds when kindFilter set (e.g. "webSearch", "webFetch")
  const filteredActiveProviders = useMemo(() => {
    if (!kindFilter) return activeProviders;
    return activeProviders.filter((p) => {
      const info = AI_PROVIDERS[p.provider];
      const kinds = info?.serviceKinds || ["llm"];
      return kinds.includes(kindFilter);
    });
  }, [activeProviders, kindFilter]);
  const { getCaps } = useModelCaps();
  const [searchQuery, setSearchQuery] = useState("");
  const [combos, setCombos] = useState([]);
  const [providerNodes, setProviderNodes] = useState([]);
  const [customModels, setCustomModels] = useState([]);
  const [syncedModelsByProvider, setSyncedModelsByProvider] = useState({});
  const [disabledModels, setDisabledModels] = useState({});
  const [testResults, setTestResults] = useState(() => loadStoredTestSession()?.results || {});
  const [testingAll, setTestingAll] = useState(false);
  const [testProgress, setTestProgress] = useState(() => loadStoredTestSession()?.progress || { done: 0, total: 0 });
  const testRunRef = useRef(0);

  const fetchCombos = async () => {
    try {
      const res = await fetch("/api/combos");
      if (!res.ok) throw new Error(`Failed to fetch combos: ${res.status}`);
      const data = await res.json();
      setCombos(data.combos || []);
    } catch (error) {
      console.error("Error fetching combos:", error);
      setCombos([]);
    }
  };

  useEffect(() => {
    if (isOpen) fetchCombos();
  }, [isOpen]);

  const fetchProviderNodes = async () => {
    try {
      const res = await fetch("/api/provider-nodes");
      if (!res.ok) throw new Error(`Failed to fetch provider nodes: ${res.status}`);
      const data = await res.json();
      setProviderNodes(data.nodes || []);
    } catch (error) {
      console.error("Error fetching provider nodes:", error);
      setProviderNodes([]);
    }
  };

  useEffect(() => {
    if (isOpen) fetchProviderNodes();
  }, [isOpen]);

  const fetchCustomModels = async () => {
    try {
      const res = await fetch("/api/models/custom");
      if (!res.ok) throw new Error(`Failed to fetch custom models: ${res.status}`);
      const data = await res.json();
      setCustomModels(data.models || []);
    } catch (error) {
      console.error("Error fetching custom models:", error);
      setCustomModels([]);
    }
  };

  useEffect(() => {
    if (isOpen) fetchCustomModels();
  }, [isOpen]);

  const fetchSyncedModels = async () => {
    try {
      const res = await fetch("/api/synced-available-models");
      if (!res.ok) throw new Error(`Failed to fetch synced models: ${res.status}`);
      const data = await res.json();
      setSyncedModelsByProvider(data.models || {});
    } catch (error) {
      console.error("Error fetching synced models:", error);
      setSyncedModelsByProvider({});
    }
  };

  useEffect(() => {
    if (isOpen) fetchSyncedModels();
  }, [isOpen]);

  const fetchDisabledModels = async () => {
    try {
      const res = await fetch("/api/models/disabled");
      if (!res.ok) throw new Error(`Failed to fetch disabled models: ${res.status}`);
      const data = await res.json();
      setDisabledModels(data.disabled || {});
    } catch (error) {
      console.error("Error fetching disabled models:", error);
      setDisabledModels({});
    }
  };

  useEffect(() => {
    if (isOpen) fetchDisabledModels();
  }, [isOpen]);

  useEffect(() => {
    if (!enableModelTesting || typeof window === "undefined") return;
    window.localStorage.setItem(
      MODEL_TEST_SESSION_KEY,
      JSON.stringify({
        results: testResults,
        progress: testProgress,
        savedAt: new Date().toISOString(),
      })
    );
  }, [enableModelTesting, testResults, testProgress]);

  const allProviders = useMemo(() => ({ ...OAUTH_PROVIDERS, ...FREE_PROVIDERS, ...FREE_TIER_PROVIDERS, ...APIKEY_PROVIDERS }), []);

  // Group models by provider with priority order
  const groupedModels = useMemo(() => {
    const groups = {};

    // Kinds where the provider IS the model (no per-model selection needed)
    const PROVIDER_AS_MODEL_KINDS = new Set(["webSearch", "webFetch"]);
    // Kinds that map directly to model.type field
    const TYPED_KINDS = new Set(["image", "tts", "stt", "embedding", "imageToText"]);
    // For these kinds, providers without hardcoded models can still be picked (provider-as-model fallback)
    const ALLOW_PROVIDER_FALLBACK_KINDS = new Set(["tts", "image", "webFetch"]);

    // Filter a models[] array by kindFilter (keep only matching kind)
    const filterByKind = (models) => {
      // No kindFilter means the LLM selector. Keep custom models visible because
      // user-added models may have typed capabilities (for example imageToText)
      // while still being valid chat/combo targets.
      if (!kindFilter) return models.filter((m) => m.isPlaceholder || m.isCustom || !getModelKind(m) || getModelKind(m) === "llm");
      if (!TYPED_KINDS.has(kindFilter)) return models;
      return models.filter((m) => m.isPlaceholder || getModelKind(m) === kindFilter);
    };

    const syncedForProvider = (providerId, valuePrefix) => {
      const syncedModels = Array.isArray(syncedModelsByProvider[providerId])
        ? syncedModelsByProvider[providerId]
        : [];
      return syncedModels
        .map((m) => {
          const rawId = m?.id || m?.name || m?.model;
          if (typeof rawId !== "string" || !rawId.trim()) return null;
          const id = rawId.trim();
          return {
            id,
            name: m?.name || m?.displayName || m?.display_name || id,
            value: `${valuePrefix}/${id}`,
            kind: getModelKind(m),
            isSynced: true,
          };
        })
        .filter(Boolean);
    };

    // Get all active provider IDs from connections (filtered by kindFilter if set)
    const activeConnectionIds = filteredActiveProviders.map(p => p.provider);

    // No-auth providers: filter by kindFilter as well
    const noAuthIds = kindFilter
      ? NO_AUTH_PROVIDER_IDS.filter((id) => (AI_PROVIDERS[id]?.serviceKinds || ["llm"]).includes(kindFilter))
      : NO_AUTH_PROVIDER_IDS;

    // Only show connected providers (including both standard and custom)
    const providerIdsToShow = new Set([
      ...activeConnectionIds,  // Only connected providers
      ...noAuthIds,            // No-auth providers (kind-filtered)
    ]);

    // Sort by PROVIDER_ORDER
    const sortedProviderIds = [...providerIdsToShow].sort((a, b) => {
      const indexA = PROVIDER_ORDER.indexOf(a);
      const indexB = PROVIDER_ORDER.indexOf(b);
      return (indexA === -1 ? 999 : indexA) - (indexB === -1 ? 999 : indexB);
    });

    sortedProviderIds.forEach((providerId) => {
      const alias = getProviderAlias(providerId);
      const providerInfo = allProviders[providerId] || { name: providerId, color: "#666" };
      const isCustomProvider = isOpenAICompatibleProvider(providerId) || isAnthropicCompatibleProvider(providerId);

      // For provider-as-model kinds (webSearch/webFetch): emit a single entry where value === providerId
      if (kindFilter && PROVIDER_AS_MODEL_KINDS.has(kindFilter)) {
        groups[providerId] = {
          name: providerInfo.name,
          alias,
          color: providerInfo.color,
          models: [{ id: providerId, name: providerInfo.name, value: providerId }],
        };
        return;
      }

      if (providerInfo.passthroughModels) {
        const aliasModels = Object.entries(modelAliases)
          .filter(([, fullModel]) => fullModel.startsWith(`${alias}/`))
          .map(([aliasName, fullModel]) => ({
            id: fullModel.replace(`${alias}/`, ""),
            name: aliasName,
            value: fullModel,
          }));
        const customRegisteredModels = customModels
          .filter((m) => m.providerAlias === alias)
          .map((m) => ({
            id: m.id,
            name: m.name || m.id,
            value: `${alias}/${m.id}`,
            kind: getModelKind(m),
            isCustom: true,
          }));

        // For typed kinds, only include hardcoded typed models (aliases are typically LLM-only and lack type info)
        let combined = aliasModels;
        if (kindFilter && TYPED_KINDS.has(kindFilter)) {
          const registeredTyped = customRegisteredModels.filter((m) => getModelKind(m) === kindFilter);
          combined = [
            ...registeredTyped,
            ...getModelsByProviderId(providerId)
            .filter((m) => getModelKind(m) === kindFilter)
            .map((m) => ({ id: m.id, name: m.name, value: `${alias}/${m.id}`, kind: getModelKind(m) }))
            .filter((m) => !registeredTyped.some((registered) => registered.value === m.value)),
          ];
          // Fallback: provider-as-model when no hardcoded models match (tts/image/webFetch only)
          if (combined.length === 0 && ALLOW_PROVIDER_FALLBACK_KINDS.has(kindFilter)) {
            const supports = (providerInfo.serviceKinds || ["llm"]).includes(kindFilter);
            if (supports) combined = [{ id: providerId, name: providerInfo.name, value: alias }];
          }
        } else {
          // LLM/null kind: merge hardcoded models (e.g. mimo-free → mimo-auto) with user-added models
          const registeredLlms = customRegisteredModels.filter((m) => !getModelKind(m) || getModelKind(m) === "llm");
          const seen = new Set([...aliasModels, ...registeredLlms].map((m) => m.value));
          const hardcoded = getModelsByProviderId(providerId)
            .filter((m) => !getModelKind(m) || getModelKind(m) === "llm")
            .map((m) => ({ id: m.id, name: m.name, value: `${alias}/${m.id}`, kind: getModelKind(m) }))
            .filter((m) => !seen.has(m.value));
          for (const m of hardcoded) seen.add(m.value);
          const synced = syncedForProvider(providerId, alias).filter((m) => !seen.has(m.value));
          combined = [
            ...registeredLlms,
            ...aliasModels.filter((m) => !registeredLlms.some((registered) => registered.value === m.value)),
            ...hardcoded,
            ...synced,
          ];
        }

        if (combined.length > 0) {
          // Check for custom name from providerNodes (for compatible providers)
          const matchedNode = providerNodes.find(node => node.id === providerId);
          const displayName = matchedNode?.name || providerInfo.name;

          groups[providerId] = {
            name: displayName,
            alias: alias,
            color: providerInfo.color,
            models: combined,
          };
        }
      } else if (isCustomProvider) {
        // Custom (openai/anthropic-compatible) providers are LLM-only — skip for typed media kinds
        if (kindFilter && TYPED_KINDS.has(kindFilter)) return;
        // Find connection object to get prefix synchronously without waiting for providerNodes fetch
        const connection = activeProviders.find(p => p.provider === providerId);
        const matchedNode = providerNodes.find(node => node.id === providerId);
        const displayName = matchedNode?.name || connection?.name || providerInfo.name;
        const nodePrefix = connection?.providerSpecificData?.prefix || matchedNode?.prefix || providerId;

        // Aliases are stored using the raw providerId as key (e.g. "openai-compatible-chat-<uuid>/glm-4.7"),
        // so we must filter by providerId, not by the display prefix.
        const nodeModels = Object.entries(modelAliases)
          .filter(([, fullModel]) => fullModel.startsWith(`${providerId}/`))
          .map(([aliasName, fullModel]) => ({
            id: fullModel.replace(`${providerId}/`, ""),
            name: aliasName,
            value: `${nodePrefix}/${fullModel.replace(`${providerId}/`, "")}`,
          }));

        const nodeModelValues = new Set(nodeModels.map((m) => m.value));
        const syncedNodeModels = filterByKind(
          syncedForProvider(providerId, nodePrefix).filter((m) => !nodeModelValues.has(m.value))
        );

        // Merge custom models registered via /api/models/custom for this provider.
        // providerAlias in DB uses the raw providerId, not the display prefix.
        const registeredCustom = customModels
          .filter((m) => m.providerAlias === providerId)
          .map((m) => ({
            id: m.id,
            name: m.name || m.id,
            value: `${nodePrefix}/${m.id}`,
            isCustom: true,
          }));
        const seenSynced = new Set(syncedNodeModels.map((m) => m.value));
        const registeredCustomModels = registeredCustom.filter(
          (m) => !nodeModelValues.has(m.value) && !seenSynced.has(m.value)
        );

        // Always show compatible providers that are connected, even with no aliases.
        // When no aliases exist, show a placeholder so users know it's available.
        const realNodeModels = [...nodeModels, ...syncedNodeModels, ...registeredCustomModels];
        const modelsToShow = realNodeModels.length > 0 ? realNodeModels : [{
          id: `__placeholder__${providerId}`,
          name: `${nodePrefix}/model-id`,
          value: `${nodePrefix}/model-id`,
          isPlaceholder: true,
        }];

        groups[providerId] = {
          name: displayName,
          alias: nodePrefix,
          color: providerInfo.color,
          models: modelsToShow,
          isCustom: true,
          hasModels: realNodeModels.length > 0,
        };
      } else {
        const hardcodedModels = getModelsByProviderId(providerId);
        const hardcodedIds = new Set(hardcodedModels.map((m) => m.id));

        // Custom models: if no hardcoded models (e.g. openrouter), show all aliases for this provider
        // Otherwise only show aliases where aliasName === modelId ("Add Model" button pattern)
        const hasHardcoded = hardcodedModels.length > 0;
        const customAliasModels = Object.entries(modelAliases)
          .filter(([aliasName, fullModel]) =>
            fullModel.startsWith(`${alias}/`) &&
            (hasHardcoded ? aliasName === fullModel.replace(`${alias}/`, "") : true) &&
            !hardcodedIds.has(fullModel.replace(`${alias}/`, ""))
          )
          .map(([aliasName, fullModel]) => {
            const modelId = fullModel.replace(`${alias}/`, "");
            return { id: modelId, name: aliasName, value: fullModel, isCustom: true };
          });

        // Custom models registered via /api/models/custom (provider "Add Model" button)
        const customAliasIds = new Set(customAliasModels.map((m) => m.id));
        const customRegisteredModels = customModels
          .filter((m) => m.providerAlias === alias && !hardcodedIds.has(m.id) && !customAliasIds.has(m.id))
          .map((m) => ({ id: m.id, name: m.name || m.id, value: `${alias}/${m.id}`, isCustom: true }));

        const customRegisteredIds = new Set(customRegisteredModels.map((m) => m.id));
        const syncedModels = syncedForProvider(providerId, alias)
          .filter((m) => !hardcodedIds.has(m.id) && !customAliasIds.has(m.id) && !customRegisteredIds.has(m.id));

        const merged = [
          ...hardcodedModels.map((m) => ({ id: m.id, name: m.name, value: `${alias}/${m.id}`, kind: getModelKind(m) })),
          ...customAliasModels,
          ...customRegisteredModels,
          ...syncedModels,
        ];
        // Dedupe by value (alias may equal hardcoded id, causing React key collision)
        const seen = new Set();
        let allModels = filterByKind(merged.filter((m) => {
          if (seen.has(m.value)) return false;
          seen.add(m.value);
          return true;
        }));

        // Provider-as-model fallback: providers that support the kind but have no hardcoded models
        // can still be picked (value = providerAlias). Skips embedding (always needs model).
        if (allModels.length === 0 && kindFilter && ALLOW_PROVIDER_FALLBACK_KINDS.has(kindFilter)) {
          const supports = (providerInfo.serviceKinds || ["llm"]).includes(kindFilter);
          if (supports) {
            allModels = [{ id: providerId, name: providerInfo.name, value: alias }];
          }
        }

        if (allModels.length > 0) {
          groups[providerId] = {
            name: providerInfo.name,
            alias: alias,
            color: providerInfo.color,
            models: allModels,
          };
        }
      }
    });

    // Filter out disabled models per provider (disabled keyed by storage alias OR providerId)
    Object.entries(groups).forEach(([providerId, group]) => {
      const aliasKey = getProviderAlias(providerId);
      const disabledIds = new Set([
        ...(disabledModels[aliasKey] || []),
        ...(disabledModels[providerId] || []),
      ]);
      if (disabledIds.size === 0) return;
      group.models = group.models.filter((m) => !disabledIds.has(m.id));
      if (group.models.length === 0) delete groups[providerId];
    });

    return groups;
  }, [filteredActiveProviders, modelAliases, allProviders, providerNodes, customModels, syncedModelsByProvider, disabledModels, kindFilter, activeProviders]);

  // Filter combos by search query (and hide combos when kindFilter is set — combos are LLM-only by design)
  const filteredCombos = useMemo(() => {
    if (kindFilter) return [];
    if (!searchQuery.trim()) return combos;
    const query = searchQuery.toLowerCase();
    return combos.filter(c => c.name.toLowerCase().includes(query));
  }, [combos, searchQuery, kindFilter]);

  // Sort models alphabetically, with added models floated to top
  const sortModels = (models) => {
    const added = models.filter(m => addedModelValues.includes(m.value)).sort((a, b) => a.name.localeCompare(b.name));
    const rest = models.filter(m => !addedModelValues.includes(m.value)).sort((a, b) => a.name.localeCompare(b.name));
    return [...added, ...rest];
  };

  // Filter models by search query
  const filteredGroups = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();

    const filtered = {};
    Object.entries(groupedModels).forEach(([providerId, group]) => {
      let models = group.models;
      if (query) {
        const providerNameMatches = group.name.toLowerCase().includes(query);
        models = models.filter(
          (m) =>
            m.name.toLowerCase().includes(query) ||
            m.id.toLowerCase().includes(query)
        );
        if (models.length === 0 && !providerNameMatches) return;
      }
      filtered[providerId] = {
        ...group,
        models: sortModels(models),
      };
    });

    return filtered;
  }, [groupedModels, searchQuery, addedModelValues]);

  const flatModelOptions = useMemo(() => {
    const seen = new Set();
    const rows = [];

    if (!kindFilter) {
      filteredCombos.forEach((combo) => {
        const value = combo.name;
        if (!value || seen.has(value)) return;
        seen.add(value);
        rows.push({
          id: value,
          name: value,
          value,
          kind: "llm",
          groupName: "Combos",
          providerId: "combos",
          isCombo: true,
        });
      });
    }

    Object.entries(filteredGroups).forEach(([providerId, group]) => {
      group.models.forEach((model) => {
        if (!model?.value || model.isPlaceholder || seen.has(model.value)) return;
        seen.add(model.value);
        rows.push({
          ...model,
          kind: model.kind || getModelKind(model) || kindFilter || "llm",
          groupName: group.name,
          providerId,
        });
      });
    });

    return rows;
  }, [filteredCombos, filteredGroups, kindFilter]);

  const testStats = useMemo(() => {
    let ok = 0;
    let failed = 0;
    let running = 0;
    flatModelOptions.forEach((model) => {
      const state = testResults[model.value]?.state;
      if (state === "ok") ok += 1;
      else if (state === "failed") failed += 1;
      else if (state === "running" || state === "queued") running += 1;
    });
    return {
      ok,
      failed,
      running,
      untested: Math.max(0, flatModelOptions.length - ok - failed - running),
    };
  }, [flatModelOptions, testResults]);

  const workingModels = useMemo(
    () => flatModelOptions.filter((model) => testResults[model.value]?.state === "ok"),
    [flatModelOptions, testResults]
  );

  const freePassedModels = useMemo(
    () => workingModels.filter(isFreePassedModel),
    [workingModels]
  );

  const hasTestHistory = useMemo(
    () => flatModelOptions.some((model) => !!testResults[model.value]),
    [flatModelOptions, testResults]
  );

  const resumableCount = useMemo(
    () => flatModelOptions.filter((model) => !TERMINAL_TEST_STATES.has(testResults[model.value]?.state)).length,
    [flatModelOptions, testResults]
  );

  const stopTesting = () => {
    testRunRef.current += 1;
    setTestingAll(false);
    setTestResults((prev) => {
      const next = { ...prev };
      Object.entries(next).forEach(([value, result]) => {
        if (result?.state === "running" || result?.state === "queued") {
          next[value] = { ...result, state: "stopped" };
        }
      });
      return next;
    });
  };

  const testOneModel = async (model, runId) => {
    setTestResults((prev) => ({
      ...prev,
      [model.value]: {
        ...(prev[model.value] || {}),
        state: "running",
        name: model.name,
        groupName: model.groupName,
        value: model.value,
      },
    }));

    try {
      const res = await fetch("/api/models/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: model.value, kind: model.kind || kindFilter || "llm" }),
      });
      const data = await res.json().catch(() => ({}));
      if (testRunRef.current !== runId) return;
      const ok = res.ok && data.ok === true;
      setTestResults((prev) => ({
        ...prev,
        [model.value]: {
          state: ok ? "ok" : "failed",
          name: model.name,
          groupName: model.groupName,
          value: model.value,
          latencyMs: data.latencyMs,
          hasOutput: !!data.hasOutput,
          sampleText: data.sampleText || "",
          error: ok ? null : data.error || `HTTP ${res.status}`,
        },
      }));
    } catch (error) {
      if (testRunRef.current !== runId) return;
      setTestResults((prev) => ({
        ...prev,
        [model.value]: {
          state: "failed",
          name: model.name,
          groupName: model.groupName,
          value: model.value,
          error: error.message || "Test failed",
        },
      }));
    } finally {
      if (testRunRef.current === runId) {
        setTestProgress((prev) => ({ ...prev, done: Math.min(prev.total, prev.done + 1) }));
      }
    }
  };

  const runModelTests = async ({ resetHistory = true } = {}) => {
    const allCandidates = flatModelOptions.filter((model) => model.value && !model.isPlaceholder);
    const candidates = resetHistory
      ? allCandidates
      : allCandidates.filter((model) => !TERMINAL_TEST_STATES.has(testResults[model.value]?.state));
    if (allCandidates.length === 0 || candidates.length === 0 || testingAll) return;

    const runId = testRunRef.current + 1;
    testRunRef.current = runId;
    setTestingAll(true);
    setTestProgress({
      done: resetHistory ? 0 : countFinishedResults(allCandidates, testResults),
      total: allCandidates.length,
    });
    setTestResults((prev) => {
      const next = resetHistory ? {} : { ...prev };
      candidates.forEach((model) => {
        next[model.value] = {
          state: "queued",
          name: model.name,
          groupName: model.groupName,
          value: model.value,
        };
      });
      return next;
    });

    const queue = [...candidates];
    const workerCount = Math.min(4, queue.length);
    await Promise.all(Array.from({ length: workerCount }, async () => {
      while (queue.length > 0 && testRunRef.current === runId) {
        const model = queue.shift();
        await testOneModel(model, runId);
      }
    }));

    if (testRunRef.current === runId) setTestingAll(false);
  };

  const continueModelTests = () => runModelTests({ resetHistory: false });

  const handleAddWorkingModels = () => {
    workingModels
      .filter((model) => !addedModelValues.includes(model.value))
      .forEach((model) => onSelect(model));
  };

  const handleAddFreePassedModels = () => {
    freePassedModels
      .filter((model) => !addedModelValues.includes(model.value))
      .forEach((model) => onSelect(model));
  };

  const handleSelect = (model) => {
    const value = model?.value || model?.name || model;
    const isAdded = addedModelValues.includes(value);

    if (isAdded && onDeselect) {
      onDeselect(model);
    } else {
      onSelect(model);
    }

    if (closeOnSelect) {
      onClose();
      setSearchQuery("");
    }
  };

  const renderTestBadge = (model) => {
    if (!enableModelTesting || !model?.value || model.isPlaceholder) return null;
    const result = testResults[model.value];
    if (!result) return null;

    const badgeClass = {
      queued: "text-text-muted bg-surface-2 border-border",
      running: "text-blue-500 bg-blue-500/10 border-blue-500/20",
      ok: "text-emerald-500 bg-emerald-500/10 border-emerald-500/25",
      failed: "text-red-500 bg-red-500/10 border-red-500/25",
      stopped: "text-text-muted bg-surface-2 border-border",
    }[result.state] || "text-text-muted bg-surface-2 border-border";

    const icon = {
      queued: "schedule",
      running: "progress_activity",
      ok: "check_circle",
      failed: "error",
      stopped: "pause_circle",
    }[result.state] || "help";

    return (
      <span
        className={`inline-flex h-4 min-w-4 items-center justify-center rounded-full border px-0.5 ${badgeClass}`}
        title={result.error || result.sampleText || (result.latencyMs ? `${result.latencyMs}ms` : result.state)}
      >
        <span className={`material-symbols-outlined text-[11px] leading-none ${result.state === "running" ? "animate-spin" : ""}`}>
          {icon}
        </span>
      </span>
    );
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={() => {
        onClose();
        setSearchQuery("");
      }}
      title={title}
      size={enableModelTesting ? "wide" : "md"}
      className={enableModelTesting ? "flex h-[calc(100vh-1rem)] flex-col overflow-hidden sm:h-[calc(100vh-2rem)]" : "p-4!"}
      bodyClassName={enableModelTesting ? "p-0 max-h-none min-h-0 flex-1 overflow-hidden" : undefined}
      footer={null}
    >
      <div className={enableModelTesting ? "grid min-h-full grid-cols-1 overflow-y-auto lg:h-full lg:min-h-0 lg:grid-cols-[minmax(0,1fr)_360px] lg:overflow-hidden xl:grid-cols-[minmax(0,1fr)_400px]" : ""}>
        <div className={enableModelTesting ? "flex min-h-[460px] flex-col p-4 sm:p-5 lg:min-h-0" : ""}>
          {/* Info bar */}
          <div className="flex items-center gap-2 mb-3 px-2.5 py-2 bg-primary/8 border border-primary/20 rounded-lg text-xs text-text-muted">
            <span className="material-symbols-outlined text-primary shrink-0" style={{ fontSize: "14px" }}>info</span>
            <span>Click to add, click again to remove. Changes are saved automatically.</span>
          </div>

          {/* Search - compact */}
          <div className="mb-3">
            <div className="relative">
              <span className="material-symbols-outlined absolute left-2.5 top-1/2 -translate-y-1/2 text-text-muted text-[16px]">
                search
              </span>
              <input
                type="text"
                placeholder="Search..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full pl-8 pr-3 py-1.5 bg-surface border border-border rounded text-xs focus:outline-none focus:ring-1 focus:ring-primary/50"
              />
            </div>
          </div>

          {/* Models grouped by provider - compact */}
          <div className={`${enableModelTesting ? "min-h-0 flex-1" : "max-h-[400px]"} overflow-y-auto space-y-3 pr-1 custom-scrollbar`}>
            {/* Combos section - always first */}
            {filteredCombos.length > 0 && (
              <div>
                <div className="flex items-center gap-1.5 mb-1.5 sticky top-0 z-10 bg-surface py-0.5">
                  <span className="material-symbols-outlined text-primary text-[14px]">layers</span>
                  <span className="text-xs font-medium text-primary">Combos</span>
                  <span className="text-[10px] text-text-muted">({filteredCombos.length})</span>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {filteredCombos.map((combo) => {
                    const comboModel = { id: combo.name, name: combo.name, value: combo.name, kind: "llm" };
                    const isSelected = selectedModel === combo.name;
                    return (
                      <button
                        key={combo.id}
                        onClick={() => handleSelect(comboModel)}
                        className={`
                          px-2 py-1 rounded-xl text-xs font-medium transition-all border hover:cursor-pointer flex items-center gap-1
                          ${isSelected
                            ? "bg-primary text-white border-primary"
                            : addedModelValues.includes(combo.name)
                              ? "bg-primary border-primary text-white hover:bg-primary-hover"
                              : "bg-surface border-border text-text-main hover:border-primary/50 hover:bg-primary/5"
                          }
                        `}
                      >
                        {addedModelValues.includes(combo.name) && (
                          <span className="material-symbols-outlined leading-none" style={{ fontSize: "10px" }}>check</span>
                        )}
                        {combo.name}
                        {renderTestBadge(comboModel)}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Provider models */}
            {Object.entries(filteredGroups).map(([providerId, group]) => (
              <div key={providerId}>
                {/* Provider header */}
                <div className="flex items-center gap-1.5 mb-1.5 sticky top-0 z-10 bg-surface py-0.5">
                  <ProviderIcon
                    src={`/providers/${providerId}.png`}
                    alt={group.name}
                    size={14}
                    fallbackText={(group.name || providerId).slice(0, 2).toUpperCase()}
                    fallbackColor={group.color}
                  />
                  <span className="text-xs font-medium text-primary">
                    {group.name}
                  </span>
                  <span className="text-[10px] text-text-muted">
                    ({group.models.length})
                  </span>
                </div>

                <div className="flex flex-wrap gap-1.5">
                  {group.models.map((model) => {
                    const isSelected = selectedModel === model.value;
                    const isPlaceholder = model.isPlaceholder;
                    return (
                      <button
                        key={model.value}
                        onClick={() => handleSelect(model)}
                        title={isPlaceholder ? "Select to pre-fill, then edit model ID in the input" : undefined}
                        className={`
                          px-2 py-1 rounded-xl text-xs font-medium transition-all border hover:cursor-pointer
                          ${isPlaceholder
                            ? "border-dashed border-border text-text-muted hover:border-primary/50 hover:text-primary bg-surface italic"
                            : isSelected
                              ? "bg-primary text-white border-primary"
                              : addedModelValues.includes(model.value)
                                ? "bg-primary border-primary text-white hover:bg-primary-hover"
                                : "bg-surface border-border text-text-main hover:border-primary/50 hover:bg-primary/5"
                          }
                        `}
                      >
                        <span className="flex items-center gap-1">
                          {addedModelValues.includes(model.value) && !isPlaceholder && (
                            <span className="material-symbols-outlined leading-none" style={{ fontSize: "10px" }}>check</span>
                          )}
                          {isPlaceholder ? (
                            <>
                              <span className="material-symbols-outlined text-[11px]">edit</span>
                              {model.name}
                            </>
                          ) : model.isCustom || model.isSynced ? (
                            <>
                              {model.name}
                              <span className="text-[9px] opacity-60 font-normal">{model.isSynced ? "synced" : "custom"}</span>
                              <CapacityBadges caps={getCaps(model.value)} />
                              {renderTestBadge(model)}
                            </>
                          ) : (
                            <>
                              {model.name}
                              <CapacityBadges caps={getCaps(model.value)} />
                              {renderTestBadge(model)}
                            </>
                          )}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}

            {Object.keys(filteredGroups).length === 0 && filteredCombos.length === 0 && (
              <div className="text-center py-4 text-text-muted">
                <span className="material-symbols-outlined text-2xl mb-1 block">
                  search_off
                </span>
                <p className="text-xs">No models found</p>
              </div>
            )}
          </div>
        </div>

        {enableModelTesting && (
          <aside className="order-first flex min-h-[360px] flex-col gap-4 border-b border-border-subtle bg-surface-2/35 p-4 lg:order-none lg:min-h-0 lg:border-b-0 lg:border-l">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="material-symbols-outlined text-primary text-[18px]">science</span>
                  <h3 className="text-sm font-semibold text-text-main">Model Health</h3>
                </div>
                <p className="mt-1 text-xs text-text-muted">{flatModelOptions.length} selectable</p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                {!testingAll && hasTestHistory && resumableCount > 0 && (
                  <Button
                    size="sm"
                    variant="secondary"
                    icon="play_arrow"
                    onClick={continueModelTests}
                  >
                    Continue
                  </Button>
                )}
                <Button
                  size="sm"
                  variant={testingAll ? "secondary" : "primary"}
                  icon={testingAll ? "stop_circle" : "bolt"}
                  onClick={testingAll ? stopTesting : () => runModelTests({ resetHistory: true })}
                  disabled={!testingAll && flatModelOptions.length === 0}
                >
                  {testingAll ? "Stop" : "Test All"}
                </Button>
              </div>
            </div>

            <div>
              <div className="mb-1 flex items-center justify-between text-[10px] text-text-muted">
                <span>{testProgress.done}/{testProgress.total || flatModelOptions.length}</span>
                <span>{testStats.ok} working</span>
              </div>
              <div className="h-1.5 overflow-hidden rounded-full bg-surface-3">
                <div
                  className="h-full rounded-full bg-primary transition-all"
                  style={{
                    width: `${testProgress.total ? Math.round((testProgress.done / testProgress.total) * 100) : 0}%`,
                  }}
                />
              </div>
            </div>

            <div className="grid grid-cols-3 gap-2">
              <div className="rounded-lg border border-emerald-500/20 bg-emerald-500/8 px-2 py-2 text-center">
                <div className="text-base font-semibold text-emerald-500">{testStats.ok}</div>
                <div className="text-[10px] text-text-muted">Pass</div>
              </div>
              <div className="rounded-lg border border-red-500/20 bg-red-500/8 px-2 py-2 text-center">
                <div className="text-base font-semibold text-red-500">{testStats.failed}</div>
                <div className="text-[10px] text-text-muted">Fail</div>
              </div>
              <div className="rounded-lg border border-border bg-surface px-2 py-2 text-center">
                <div className="text-base font-semibold text-text-main">{testStats.untested}</div>
                <div className="text-[10px] text-text-muted">Idle</div>
              </div>
            </div>

            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-semibold text-text-main">Working Models</span>
              <div className="flex items-center gap-1.5">
                <button
                  onClick={handleAddFreePassedModels}
                  disabled={freePassedModels.length === 0 || freePassedModels.every((model) => addedModelValues.includes(model.value))}
                  className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium text-emerald-500 transition-colors hover:bg-emerald-500/10 disabled:cursor-not-allowed disabled:text-text-muted"
                  title={`${freePassedModels.length} free passed model${freePassedModels.length === 1 ? "" : "s"}`}
                >
                  <span className="material-symbols-outlined text-[13px]">auto_awesome</span>
                  Free passed
                </button>
                <button
                  onClick={handleAddWorkingModels}
                  disabled={workingModels.every((model) => addedModelValues.includes(model.value))}
                  className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium text-primary transition-colors hover:bg-primary/10 disabled:cursor-not-allowed disabled:text-text-muted"
                >
                  <span className="material-symbols-outlined text-[13px]">playlist_add</span>
                  Add passed
                </button>
              </div>
            </div>

            <div className="min-h-0 flex-1 space-y-2 overflow-y-auto pr-1 custom-scrollbar">
              {workingModels.length === 0 ? (
                <div className="flex h-full min-h-[160px] flex-col items-center justify-center rounded-xl border border-dashed border-border text-center text-text-muted">
                  <span className="material-symbols-outlined text-[24px]">rule</span>
                  <p className="mt-1 text-xs">No passing models yet</p>
                </div>
              ) : (
                workingModels.map((model) => {
                  const isAdded = addedModelValues.includes(model.value);
                  const result = testResults[model.value];
                  return (
                    <button
                      key={model.value}
                      onClick={() => handleSelect(model)}
                      className={`w-full rounded-lg border px-2.5 py-2 text-left transition-colors ${
                        isAdded
                          ? "border-primary bg-primary/10"
                          : "border-border bg-surface hover:border-primary/40 hover:bg-primary/5"
                      }`}
                    >
                      <div className="flex min-w-0 items-center justify-between gap-2">
                        <span className="truncate text-xs font-semibold text-text-main">{model.name}</span>
                        <span className="shrink-0 text-[10px] text-emerald-500">{result?.latencyMs ? `${result.latencyMs}ms` : "ok"}</span>
                      </div>
                      <div className="mt-1 flex items-center gap-1 text-[10px] text-text-muted">
                        <span className="truncate">{model.groupName}</span>
                        {isAdded && <span className="text-primary">selected</span>}
                      </div>
                      {result?.sampleText && (
                        <div className="mt-1 truncate text-[10px] text-text-muted" title={result.sampleText}>
                          {result.sampleText}
                        </div>
                      )}
                    </button>
                  );
                })
              )}
            </div>
          </aside>
        )}
      </div>
    </Modal>
  );
}

ModelSelectModal.propTypes = {
  isOpen: PropTypes.bool.isRequired,
  onClose: PropTypes.func.isRequired,
  onSelect: PropTypes.func.isRequired,
  onDeselect: PropTypes.func,
  selectedModel: PropTypes.string,
  activeProviders: PropTypes.arrayOf(
    PropTypes.shape({
      provider: PropTypes.string.isRequired,
    })
  ),
  title: PropTypes.string,
  modelAliases: PropTypes.object,
  kindFilter: PropTypes.string,
  addedModelValues: PropTypes.arrayOf(PropTypes.string),
  closeOnSelect: PropTypes.bool,
  enableModelTesting: PropTypes.bool,
};
