import {
  getProviderConnectionById,
  replaceSyncedAvailableModels,
  updateProviderConnection,
} from "@/lib/localDb";
import { createNoAuthModelsConnection, fetchModelsForConnection } from "@/app/api/providers/[id]/models/route.js";

function normalizeSyncedModels(models) {
  const seen = new Set();
  const out = [];
  for (const model of Array.isArray(models) ? models : []) {
    const id = model?.id || model?.name || model?.model;
    if (typeof id !== "string" || !id.trim()) continue;
    const normalizedId = id.trim();
    if (seen.has(normalizedId)) continue;
    seen.add(normalizedId);
    out.push({
      ...model,
      id: normalizedId,
      name: model?.name || model?.displayName || model?.display_name || normalizedId,
      source: "auto-sync",
    });
  }
  return out;
}

export async function syncProviderConnectionModels(connectionId) {
  let connection = await getProviderConnectionById(connectionId);
  const isPersistedConnection = Boolean(connection);
  if (!connection) {
    connection = createNoAuthModelsConnection(connectionId);
  }
  if (!connection) {
    return { ok: false, status: 404, error: "Connection not found" };
  }

  const result = await fetchModelsForConnection(connection);
  if (result?.error) {
    return {
      ok: false,
      status: result.status || 500,
      provider: connection.provider,
      connectionId,
      error: result.error,
    };
  }

  const models = normalizeSyncedModels(result.models);
  if (models.length === 0) {
    return {
      ok: false,
      status: 502,
      provider: connection.provider,
      connectionId,
      error: result.warning || "No models returned from provider",
    };
  }

  const syncedAt = new Date().toISOString();
  const persisted = await replaceSyncedAvailableModels(connection.provider, models, {
    connectionId,
    provider: connection.provider,
    warning: result.warning || null,
    syncedAt,
  });

  if (isPersistedConnection) {
    await updateProviderConnection(connectionId, {
      providerSpecificData: {
        ...(connection.providerSpecificData || {}),
        lastModelSyncAt: syncedAt,
        lastModelSyncCount: persisted.length,
        lastModelSyncError: null,
      },
    });
  }

  return {
    ok: true,
    provider: connection.provider,
    connectionId,
    syncedModels: persisted.length,
    warning: result.warning || null,
    models: persisted,
  };
}
