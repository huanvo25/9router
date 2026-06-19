import { getAdapter } from "../driver.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";
import { makeKv } from "../helpers/kvStore.js";

const aliasKv = makeKv("modelAliases");
const customKv = makeKv("customModels");
const mitmKv = makeKv("mitmAlias");
const syncedModelsKv = makeKv("syncedAvailableModels");

// modelAliases: key=alias, value=modelString
export async function getModelAliases() {
  return await aliasKv.getAll();
}

export async function setModelAlias(alias, model) {
  await aliasKv.set(alias, model);
}

export async function deleteModelAlias(alias) {
  await aliasKv.remove(alias);
}

// customModels: key=`${providerAlias}|${id}|${type}`, value=full model object
function customKey(providerAlias, id, type) {
  return `${providerAlias}|${id}|${type}`;
}

export async function getCustomModels() {
  const all = await customKv.getAll();
  return Object.values(all);
}

// Atomic check-then-insert inside transaction to prevent duplicate races
export async function addCustomModel({ providerAlias, id, type = "llm", name }) {
  const k = customKey(providerAlias, id, type);
  const db = await getAdapter();
  let added = false;
  db.transaction(() => {
    const row = db.get(`SELECT 1 FROM kv WHERE scope = 'customModels' AND key = ?`, [k]);
    if (row) return;
    const value = stringifyJson({ providerAlias, id, type, name: name || id });
    db.run(`INSERT INTO kv(scope, key, value) VALUES('customModels', ?, ?)`, [k, value]);
    added = true;
  });
  return added;
}

export async function deleteCustomModel({ providerAlias, id, type = "llm" }) {
  await customKv.remove(customKey(providerAlias, id, type));
}

// syncedAvailableModels: key=providerId, value={ models, syncedAt, connectionId }
export async function getSyncedAvailableModels(providerId) {
  if (!providerId) return [];
  const record = await syncedModelsKv.get(providerId, null);
  if (Array.isArray(record)) return record;
  return Array.isArray(record?.models) ? record.models : [];
}

export async function getAllSyncedAvailableModels() {
  const all = await syncedModelsKv.getAll();
  const out = {};
  for (const [providerId, record] of Object.entries(all)) {
    out[providerId] = Array.isArray(record) ? record : (record?.models || []);
  }
  return out;
}

export async function replaceSyncedAvailableModels(providerId, models, metadata = {}) {
  const normalized = Array.isArray(models)
    ? models
        .map((model) => {
          const id = model?.id || model?.name || model?.model;
          if (typeof id !== "string" || !id.trim()) return null;
          return {
            ...model,
            id: id.trim(),
            name: model?.name || model?.displayName || model?.display_name || id.trim(),
            source: model?.source || "auto-sync",
          };
        })
        .filter(Boolean)
    : [];

  await syncedModelsKv.set(providerId, {
    models: normalized,
    syncedAt: new Date().toISOString(),
    ...metadata,
  });
  return normalized;
}

export async function clearSyncedAvailableModels(providerId) {
  await syncedModelsKv.remove(providerId);
}

// mitmAlias: key=toolName, value=mappings object
export async function getMitmAlias(toolName) {
  if (toolName) {
    const v = await mitmKv.get(toolName);
    return v || {};
  }
  return await mitmKv.getAll();
}

export async function setMitmAliasAll(toolName, mappings) {
  await mitmKv.set(toolName, mappings || {});
}
