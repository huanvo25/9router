import { EventEmitter } from "events";
import { getAdapter } from "../driver.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";
import { getMeta, setMeta } from "../helpers/metaStore.js";

function maskApiKey(key) {
  if (!key || typeof key !== "string") return null;
  if (key.length <= 8) return key.charAt(0) + "***";
  return key.slice(0, 8) + "***";
}

const PENDING_TIMEOUT_MS = 60 * 1000;
const RECENT_REQUEST_LIMIT = 100;
const RECENT_HISTORY_SCAN_LIMIT = 300;
const RING_CAP = 120;
const CONN_CACHE_TTL_MS = 30 * 1000;
const DAY_MS = 86400000;
const PERIOD_MS = { "24h": DAY_MS, "7d": 7 * DAY_MS, "30d": 30 * DAY_MS, "60d": 60 * DAY_MS, "1y": 365 * DAY_MS };
const GENERIC_PROVIDER_IDS = new Set(["openai-compatible", "anthropic-compatible", "custom-embedding"]);
const BUILTIN_PROVIDER_NAMES = {
  openai: "OpenAI",
  codex: "OpenAI Codex",
  kiro: "Kiro",
  opencode: "OpenCode",
  antigravity: "Antigravity",
  openrouter: "OpenRouter",
  ollama: "Ollama",
  "ollama-local": "Ollama Local",
  nvidia: "NVIDIA",
  "cloudflare-ai": "Cloudflare AI",
};
const LEGACY_COMPATIBLE_PROVIDER_NAMES = {
  "openai-compatible-49bbe6c1-5692-4933-a2ab-346474fe7089": "VietAPI",
  "openai-compatible-responses-49bbe6c1-5692-4933-a2ab-346474fe7089": "VietAPI",
};

// In-memory state shared across Next.js modules
if (!global._pendingRequests) global._pendingRequests = { byModel: {}, byAccount: {} };
if (!global._lastErrorProvider) global._lastErrorProvider = { provider: "", ts: 0 };
if (!global._statsEmitter) {
  global._statsEmitter = new EventEmitter();
  global._statsEmitter.setMaxListeners(50);
}
if (!global._pendingTimers) global._pendingTimers = {};
if (!global._recentRing) global._recentRing = { items: [], initialized: false };
if (!global._connectionMapCache) global._connectionMapCache = { map: {}, accountNameMap: {}, providerLookups: null, ts: 0 };
if (!global._statsEmitTimers) global._statsEmitTimers = { pending: null, update: null };

const pendingRequests = global._pendingRequests;
const lastErrorProvider = global._lastErrorProvider;
const pendingTimers = global._pendingTimers;
const recentRing = global._recentRing;
const connCache = global._connectionMapCache;
const statsEmitTimers = global._statsEmitTimers;

export const statsEmitter = global._statsEmitter;

function scheduleStatsEvent(event, delayMs = 150) {
  const key = event === "update" ? "update" : "pending";
  if (statsEmitTimers[key]) return;
  statsEmitTimers[key] = setTimeout(() => {
    statsEmitTimers[key] = null;
    statsEmitter.emit(event);
  }, delayMs);
  statsEmitTimers[key]?.unref?.();
}

function getLocalDateKey(timestamp) {
  const d = timestamp ? new Date(timestamp) : new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function addToCounter(target, key, values) {
  if (!target[key]) target[key] = { requests: 0, promptTokens: 0, completionTokens: 0, cost: 0 };
  target[key].requests += values.requests || 1;
  target[key].promptTokens += values.promptTokens || 0;
  target[key].completionTokens += values.completionTokens || 0;
  target[key].cost += values.cost || 0;
  if (values.meta) Object.assign(target[key], values.meta);
}

function aggregateEntryToDay(day, entry) {
  const promptTokens = entry.tokens?.prompt_tokens || entry.tokens?.input_tokens || 0;
  const completionTokens = entry.tokens?.completion_tokens || entry.tokens?.output_tokens || 0;
  const cost = entry.cost || 0;
  const vals = { promptTokens, completionTokens, cost };

  day.requests = (day.requests || 0) + 1;
  day.promptTokens = (day.promptTokens || 0) + promptTokens;
  day.completionTokens = (day.completionTokens || 0) + completionTokens;
  day.cost = (day.cost || 0) + cost;

  day.byProvider ||= {};
  day.byModel ||= {};
  day.byAccount ||= {};
  day.byApiKey ||= {};
  day.byEndpoint ||= {};

  if (entry.provider) addToCounter(day.byProvider, entry.provider, vals);

  const modelKey = entry.provider ? `${entry.model}|${entry.provider}` : entry.model;
  addToCounter(day.byModel, modelKey, { ...vals, meta: { rawModel: entry.model, provider: entry.provider } });

  if (entry.connectionId) {
    addToCounter(day.byAccount, entry.connectionId, { ...vals, meta: { rawModel: entry.model, provider: entry.provider } });
  }

  const apiKeyVal = entry.apiKey && typeof entry.apiKey === "string" ? entry.apiKey : "local-no-key";
  const akModelKey = `${apiKeyVal}|${entry.model}|${entry.provider || "unknown"}`;
  addToCounter(day.byApiKey, akModelKey, { ...vals, meta: { rawModel: entry.model, provider: entry.provider, apiKey: entry.apiKey || null } });

  const endpoint = entry.endpoint || "Unknown";
  const epKey = `${endpoint}|${entry.model}|${entry.provider || "unknown"}`;
  addToCounter(day.byEndpoint, epKey, { ...vals, meta: { endpoint, rawModel: entry.model, provider: entry.provider } });
}

function pushToRing(entry) {
  recentRing.items.push(entry);
  if (recentRing.items.length > RING_CAP) {
    recentRing.items = recentRing.items.slice(-RING_CAP);
  }
}

function getPromptTokens(entry = {}) {
  const tokens = entry.tokens || {};
  return Number(entry.promptTokens ?? tokens.prompt_tokens ?? tokens.input_tokens ?? 0) || 0;
}

function getCompletionTokens(entry = {}) {
  const tokens = entry.tokens || {};
  return Number(entry.completionTokens ?? tokens.completion_tokens ?? tokens.output_tokens ?? 0) || 0;
}

function isOkStatus(status) {
  const value = String(status || "").trim().toLowerCase();
  return !value || value === "ok" || value === "success";
}

function getUsageError(entry = {}) {
  const promptTokens = getPromptTokens(entry);
  const completionTokens = getCompletionTokens(entry);
  const statusError = !isOkStatus(entry.status);
  const inputZero = promptTokens <= 0;
  const outputZero = completionTokens <= 0;
  const reasons = [];

  if (statusError) reasons.push(`status:${entry.status || "unknown"}`);
  if (inputZero) reasons.push("input=0");
  if (outputZero) reasons.push("output=0");

  return {
    isError: statusError || inputZero || outputZero,
    statusError,
    zeroTokenError: inputZero || outputZero,
    promptTokens,
    completionTokens,
    reason: reasons.join(", "),
  };
}

function isZeroTokenRequest(entry) {
  const error = getUsageError(entry);
  return error.zeroTokenError;
}

function normalizeProviderKey(provider) {
  if (typeof provider !== "string") return "unknown";
  const trimmed = provider.trim();
  return trimmed || "unknown";
}

function isGenericUsageProvider(provider) {
  return GENERIC_PROVIDER_IDS.has(normalizeProviderKey(provider));
}

function getProviderDisplayName(provider, providerNameMap = {}, connectionMeta = null) {
  const normalized = normalizeProviderKey(provider);
  return providerNameMap[normalized] || connectionMeta?.providerName || normalized;
}

function buildProviderLookups(connections = [], providerNodes = []) {
  const providerNameMap = { ...BUILTIN_PROVIDER_NAMES, ...LEGACY_COMPATIBLE_PROVIDER_NAMES };
  const connectionProviderMap = {};

  for (const node of providerNodes || []) {
    if (node?.id && node?.name) {
      providerNameMap[node.id] = node.name;
      if (node.id.startsWith("openai-compatible-responses-")) {
        providerNameMap[node.id.replace(/^openai-compatible-responses-/, "openai-compatible-")] = node.name;
      } else if (node.id.startsWith("openai-compatible-")) {
        providerNameMap[node.id.replace(/^openai-compatible-/, "openai-compatible-responses-")] = node.name;
      }
    }
    if (node?.prefix && node?.name) providerNameMap[node.prefix] = node.name;
  }

  for (const connection of connections || []) {
    const provider = normalizeProviderKey(connection?.provider);
    const providerName = providerNameMap[provider]
      || connection?.providerSpecificData?.nodeName
      || connection?.displayName
      || connection?.name
      || connection?.email
      || provider;

    if (!providerNameMap[provider]) providerNameMap[provider] = providerName;
    if (provider.startsWith("openai-compatible-responses-")) {
      const chatProvider = provider.replace(/^openai-compatible-responses-/, "openai-compatible-");
      if (!providerNameMap[chatProvider]) providerNameMap[chatProvider] = providerName;
    } else if (provider.startsWith("openai-compatible-")) {
      const responsesProvider = provider.replace(/^openai-compatible-/, "openai-compatible-responses-");
      if (!providerNameMap[responsesProvider]) providerNameMap[responsesProvider] = providerName;
    }
    if (connection?.id) {
      connectionProviderMap[connection.id] = {
        provider,
        providerName: getProviderDisplayName(provider, providerNameMap, { providerName }),
      };
    }
  }

  return { providerNameMap, connectionProviderMap };
}

function resolveUsageProvider(entry = {}, providerLookups = {}) {
  const connectionMeta = entry.connectionId
    ? providerLookups.connectionProviderMap?.[entry.connectionId]
    : null;
  let provider = normalizeProviderKey(entry.provider);

  if (connectionMeta?.provider && (provider === "unknown" || isGenericUsageProvider(provider))) {
    provider = connectionMeta.provider;
  }

  return {
    provider,
    providerName: getProviderDisplayName(provider, providerLookups.providerNameMap || {}, connectionMeta),
  };
}

function toRecentRequest(entry, providerLookups = {}) {
  const error = getUsageError(entry);
  const { provider, providerName } = resolveUsageProvider(entry, providerLookups);
  return {
    timestamp: entry.timestamp,
    model: entry.model,
    provider,
    providerName,
    promptTokens: error.promptTokens,
    completionTokens: error.completionTokens,
    status: entry.status || "ok",
    isError: error.isError,
    errorReason: error.reason,
  };
}

function dedupeRecentRequests(entries, limit = RECENT_REQUEST_LIMIT) {
  const seen = new Set();
  return entries
    .filter((e) => e?.timestamp && e?.model)
    .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
    .filter((e) => {
      if (isZeroTokenRequest(e)) return true;
      const minute = e.timestamp ? e.timestamp.slice(0, 16) : "";
      const key = `${e.model}|${e.provider}|${e.promptTokens}|${e.completionTokens}|${minute}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, limit);
}

function getRecentErrorDetailRequests(db, limit = 50, providerLookups = {}) {
  try {
    const rows = db.all(
      `SELECT data FROM requestDetails
       WHERE LOWER(COALESCE(status, '')) NOT IN ('', 'ok', 'success')
       ORDER BY timestamp DESC
       LIMIT ?`,
      [limit]
    );
    return rows.map((r) => toRecentRequest(parseJson(r.data, {}) || {}, providerLookups));
  } catch {
    return [];
  }
}

async function getConnectionDataCached() {
  if (Date.now() - connCache.ts < CONN_CACHE_TTL_MS && connCache.accountNameMap && connCache.providerLookups) {
    return {
      accountNameMap: connCache.accountNameMap,
      providerLookups: connCache.providerLookups,
    };
  }

  try {
    const { getProviderConnections } = await import("./connectionsRepo.js");
    const { getProviderNodes } = await import("./nodesRepo.js");
    const all = await getProviderConnections();
    const nodes = await getProviderNodes();
    const accountNameMap = {};
    for (const c of all) accountNameMap[c.id] = c.name || c.email || c.id;
    connCache.map = accountNameMap;
    connCache.accountNameMap = accountNameMap;
    connCache.providerLookups = buildProviderLookups(all, nodes);
    connCache.ts = Date.now();
  } catch {}

  return {
    accountNameMap: connCache.accountNameMap || connCache.map || {},
    providerLookups: connCache.providerLookups || buildProviderLookups(),
  };
}

async function ensureRingInitialized() {
  if (recentRing.initialized) return;
  recentRing.initialized = true;
  try {
    const db = await getAdapter();
    const rows = db.all(`SELECT timestamp, provider, model, connectionId, apiKey, endpoint, promptTokens, completionTokens, cost, status, tokens FROM usageHistory ORDER BY id DESC LIMIT ?`, [RING_CAP]);
    recentRing.items = rows.reverse().map((r) => ({
      timestamp: r.timestamp, provider: r.provider, model: r.model, connectionId: r.connectionId,
      apiKey: r.apiKey, endpoint: r.endpoint, promptTokens: r.promptTokens, completionTokens: r.completionTokens, cost: r.cost, status: r.status,
      tokens: parseJson(r.tokens, {}),
    }));
  } catch {}
}

async function calculateCost(provider, model, tokens) {
  if (!tokens || !provider || !model) return 0;
  try {
    const { getPricingForModel } = await import("./pricingRepo.js");
    const pricing = await getPricingForModel(provider, model);
    if (!pricing) return 0;

    let cost = 0;
    const inputTokens = tokens.prompt_tokens || tokens.input_tokens || 0;
    const cachedTokens = tokens.cached_tokens || tokens.cache_read_input_tokens || 0;
    const nonCachedInput = Math.max(0, inputTokens - cachedTokens);
    cost += nonCachedInput * (pricing.input / 1000000);

    if (cachedTokens > 0) {
      const cachedRate = pricing.cached || pricing.input;
      cost += cachedTokens * (cachedRate / 1000000);
    }

    const outputTokens = tokens.completion_tokens || tokens.output_tokens || 0;
    cost += outputTokens * (pricing.output / 1000000);

    const reasoningTokens = tokens.reasoning_tokens || 0;
    if (reasoningTokens > 0) {
      const rate = pricing.reasoning || pricing.output;
      cost += reasoningTokens * (rate / 1000000);
    }

    const cacheCreationTokens = tokens.cache_creation_input_tokens || 0;
    if (cacheCreationTokens > 0) {
      const rate = pricing.cache_creation || pricing.input;
      cost += cacheCreationTokens * (rate / 1000000);
    }

    return cost;
  } catch (e) {
    console.error("Error calculating cost:", e);
    return 0;
  }
}

export function trackPendingRequest(model, provider, connectionId, started, error = false) {
  const modelKey = provider ? `${model} (${provider})` : model;
  const timerKey = `${connectionId}|${modelKey}`;

  if (!pendingRequests.byModel[modelKey]) pendingRequests.byModel[modelKey] = 0;
  pendingRequests.byModel[modelKey] = Math.max(0, pendingRequests.byModel[modelKey] + (started ? 1 : -1));
  if (pendingRequests.byModel[modelKey] === 0) delete pendingRequests.byModel[modelKey];

  if (connectionId) {
    if (!pendingRequests.byAccount[connectionId]) pendingRequests.byAccount[connectionId] = {};
    if (!pendingRequests.byAccount[connectionId][modelKey]) pendingRequests.byAccount[connectionId][modelKey] = 0;
    pendingRequests.byAccount[connectionId][modelKey] = Math.max(0, pendingRequests.byAccount[connectionId][modelKey] + (started ? 1 : -1));
    if (pendingRequests.byAccount[connectionId][modelKey] === 0) {
      delete pendingRequests.byAccount[connectionId][modelKey];
      if (Object.keys(pendingRequests.byAccount[connectionId]).length === 0) {
        delete pendingRequests.byAccount[connectionId];
      }
    }
  }

  if (started) {
    clearTimeout(pendingTimers[timerKey]);
    pendingTimers[timerKey] = setTimeout(() => {
      delete pendingTimers[timerKey];
      if (pendingRequests.byModel[modelKey] > 0) pendingRequests.byModel[modelKey] = 0;
      if (connectionId && pendingRequests.byAccount[connectionId]?.[modelKey] > 0) {
        pendingRequests.byAccount[connectionId][modelKey] = 0;
      }
      scheduleStatsEvent("pending");
    }, PENDING_TIMEOUT_MS);
  } else {
    clearTimeout(pendingTimers[timerKey]);
    delete pendingTimers[timerKey];
  }

  if (!started && error && provider) {
    lastErrorProvider.provider = provider.toLowerCase();
    lastErrorProvider.ts = Date.now();
  }

  const t = new Date().toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
  console.log(`[${t}] [PENDING] ${started ? "START" : "END"}${error ? " (ERROR)" : ""} | provider=${provider} | model=${model}`);
  scheduleStatsEvent("pending");
}

export async function getActiveRequests() {
  const activeRequests = [];
  const { accountNameMap: connectionMap, providerLookups } = await getConnectionDataCached();
  const accountedByModel = {};

  for (const [connectionId, models] of Object.entries(pendingRequests.byAccount)) {
    for (const [modelKey, count] of Object.entries(models)) {
      if (count > 0) {
        accountedByModel[modelKey] = (accountedByModel[modelKey] || 0) + count;
        const accountName = connectionMap[connectionId] || `Account ${connectionId.slice(0, 8)}...`;
        const match = modelKey.match(/^(.*) \((.*)\)$/);
        activeRequests.push({
          model: match ? match[1] : modelKey,
          provider: match ? match[2] : "unknown",
          account: accountName, count,
        });
      }
    }
  }

  for (const [modelKey, count] of Object.entries(pendingRequests.byModel)) {
    const unaccountedCount = count - (accountedByModel[modelKey] || 0);
    if (unaccountedCount > 0) {
      const match = modelKey.match(/^(.*) \((.*)\)$/);
      activeRequests.push({
        model: match ? match[1] : modelKey,
        provider: match ? match[2] : "unknown",
        account: "Unknown account",
        count: unaccountedCount,
      });
    }
  }

  await ensureRingInitialized();
  const db = await getAdapter();
  const recentRequests = dedupeRecentRequests([
    ...recentRing.items.map((entry) => toRecentRequest(entry, providerLookups)),
    ...getRecentErrorDetailRequests(db, RECENT_REQUEST_LIMIT, providerLookups),
  ]);

  const errorProvider = (Date.now() - lastErrorProvider.ts < 10000) ? lastErrorProvider.provider : "";
  return { activeRequests, recentRequests, errorProvider };
}

export async function saveRequestUsage(entry) {
  try {
    const db = await getAdapter();

    if (!entry.timestamp) entry.timestamp = new Date().toISOString();
    entry.cost = await calculateCost(entry.provider, entry.model, entry.tokens);

    const tokens = entry.tokens || {};
    const promptTokens = tokens.prompt_tokens || tokens.input_tokens || 0;
    const completionTokens = tokens.completion_tokens || tokens.output_tokens || 0;

    let inserted = false;

    // All 3 writes (history insert, daily upsert, lifetime counter) in ONE transaction.
    // better-sqlite3 is sync → no JS yield mid-transaction → no race in same process.
    db.transaction(() => {
      const existing = db.get(
        `SELECT id, endpoint FROM usageHistory
         WHERE timestamp = ?
           AND COALESCE(provider, '') = COALESCE(?, '')
           AND COALESCE(model, '') = COALESCE(?, '')
           AND COALESCE(connectionId, '') = COALESCE(?, '')
           AND COALESCE(apiKey, '') = COALESCE(?, '')
           AND promptTokens = ?
           AND completionTokens = ?
         ORDER BY id DESC LIMIT 1`,
        [
          entry.timestamp, entry.provider || null, entry.model || null,
          entry.connectionId || null, entry.apiKey || null,
          promptTokens, completionTokens,
        ]
      );

      if (existing) {
        if (!existing.endpoint && entry.endpoint) {
          db.run(`UPDATE usageHistory SET endpoint = ? WHERE id = ?`, [entry.endpoint, existing.id]);
        }
        return;
      }

      db.run(
        `INSERT INTO usageHistory(timestamp, provider, model, connectionId, apiKey, endpoint, promptTokens, completionTokens, cost, status, tokens, meta) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          entry.timestamp, entry.provider || null, entry.model || null,
          entry.connectionId || null, entry.apiKey || null, entry.endpoint || null,
          promptTokens, completionTokens, entry.cost || 0, entry.status || "ok",
          stringifyJson(tokens), stringifyJson({}),
        ]
      );

      const dateKey = getLocalDateKey(entry.timestamp);
      const row = db.get(`SELECT data FROM usageDaily WHERE dateKey = ?`, [dateKey]);
      const day = row ? parseJson(row.data, {}) : {
        requests: 0, promptTokens: 0, completionTokens: 0, cost: 0,
        byProvider: {}, byModel: {}, byAccount: {}, byApiKey: {}, byEndpoint: {},
      };
      aggregateEntryToDay(day, entry);
      db.run(`INSERT INTO usageDaily(dateKey, data) VALUES(?, ?) ON CONFLICT(dateKey) DO UPDATE SET data = excluded.data`, [dateKey, stringifyJson(day)]);

      // Atomic counter increment in same transaction
      const cur = db.get(`SELECT value FROM _meta WHERE key = 'totalRequestsLifetime'`);
      const next = (cur ? parseInt(cur.value, 10) : 0) + 1;
      db.run(`INSERT INTO _meta(key, value) VALUES('totalRequestsLifetime', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, [String(next)]);
      inserted = true;
    });

    if (inserted) {
      pushToRing(entry);
      scheduleStatsEvent("update", 250);
    }
  } catch (e) {
    console.error("Failed to save usage stats:", e);
  }
}

export async function getUsageHistory(filter = {}) {
  const db = await getAdapter();
  const conds = [];
  const params = [];

  if (filter.provider) { conds.push("provider = ?"); params.push(filter.provider); }
  if (filter.model) { conds.push("model = ?"); params.push(filter.model); }
  if (filter.startDate) { conds.push("timestamp >= ?"); params.push(new Date(filter.startDate).toISOString()); }
  if (filter.endDate) { conds.push("timestamp <= ?"); params.push(new Date(filter.endDate).toISOString()); }

  const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
  const rows = db.all(`SELECT timestamp, provider, model, connectionId, apiKey, endpoint, cost, status, tokens FROM usageHistory ${where} ORDER BY id ASC`, params);

  return rows.map((r) => ({
    timestamp: r.timestamp, provider: r.provider, model: r.model,
    connectionId: r.connectionId, apiKeyMasked: maskApiKey(r.apiKey), endpoint: r.endpoint,
    cost: r.cost, status: r.status, tokens: parseJson(r.tokens, {}),
  }));
}

function loadDaysInRange(adapter, maxDays) {
  if (maxDays == null) {
    return adapter.all(`SELECT dateKey, data FROM usageDaily`);
  }
  const today = new Date();
  const cutoff = new Date(today.getFullYear(), today.getMonth(), today.getDate() - maxDays + 1);
  const cutoffKey = `${cutoff.getFullYear()}-${String(cutoff.getMonth() + 1).padStart(2, "0")}-${String(cutoff.getDate()).padStart(2, "0")}`;
  return adapter.all(`SELECT dateKey, data FROM usageDaily WHERE dateKey >= ?`, [cutoffKey]);
}

function getPeriodStart(period, now = new Date()) {
  if (period === "today") {
    const startOfDay = new Date(now);
    startOfDay.setHours(0, 0, 0, 0);
    return startOfDay.getTime();
  }
  if (PERIOD_MS[period]) return now.getTime() - PERIOD_MS[period];
  return null;
}

function getErrorRanges(now = new Date()) {
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  return [
    { key: "today", label: "Today", start: startOfToday.getTime() },
    { key: "24h", label: "24h", start: now.getTime() - PERIOD_MS["24h"] },
    { key: "7d", label: "7D", start: now.getTime() - PERIOD_MS["7d"] },
    { key: "30d", label: "30D", start: now.getTime() - PERIOD_MS["30d"] },
    { key: "60d", label: "60D", start: now.getTime() - PERIOD_MS["60d"] },
    { key: "1y", label: "1Y", start: now.getTime() - PERIOD_MS["1y"] },
  ];
}

function getUsageErrorCounts(db, providerLookups = {}) {
  const now = new Date();
  const ranges = getErrorRanges(now).map((range) => ({
    ...range,
    count: 0,
    statusErrorCount: 0,
    zeroTokenCount: 0,
    providers: {},
  }));
  const earliest = Math.min(...ranges.map((r) => r.start));
  const rows = db.all(
    `SELECT timestamp, provider, model, connectionId, promptTokens, completionTokens, status, tokens
     FROM usageHistory
     WHERE timestamp >= ?`,
    [new Date(earliest).toISOString()]
  );

  for (const row of rows) {
    const ts = new Date(row.timestamp).getTime();
    if (!Number.isFinite(ts)) continue;

    const error = getUsageError({ ...row, tokens: parseJson(row.tokens, {}) || {} });
    if (!error.isError) continue;

    const { provider, providerName } = resolveUsageProvider(row, providerLookups);
    for (const range of ranges) {
      if (ts < range.start || ts > now.getTime()) continue;

      range.count += 1;
      if (error.statusError) range.statusErrorCount += 1;
      if (error.zeroTokenError) range.zeroTokenCount += 1;
      if (!range.providers[provider]) {
        range.providers[provider] = {
          provider,
          providerName,
          count: 0,
          statusErrorCount: 0,
          zeroTokenCount: 0,
        };
      }
      range.providers[provider].count += 1;
      if (error.statusError) range.providers[provider].statusErrorCount += 1;
      if (error.zeroTokenError) range.providers[provider].zeroTokenCount += 1;
    }
  }

  return ranges.map(({ start, providers, ...range }) => ({
    ...range,
    providers: Object.values(providers)
      .sort((a, b) => b.count - a.count || a.provider.localeCompare(b.provider))
      .slice(0, 5),
  }));
}

function createModelProviderRow(model, provider, providerName) {
  return {
    providerModelKey: `${provider}\u0000${model}`,
    model,
    provider,
    providerName,
    totalRequests: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    cost: 0,
    errorCount: 0,
    zeroTokenCount: 0,
    statusErrorCount: 0,
    providerCount: 0,
    lastUsed: null,
    providers: {},
  };
}

function createProviderUsageRow(provider, providerName) {
  return {
    provider,
    providerName,
    requests: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    cost: 0,
    errorCount: 0,
    zeroTokenCount: 0,
    statusErrorCount: 0,
    lastUsed: null,
  };
}

function withErrorRate(row) {
  const total = row.totalRequests || row.requests || 0;
  return {
    ...row,
    errorRate: total > 0 ? (row.errorCount || 0) / total : 0,
  };
}

function getModelProviderUsage(db, period = "all", providerLookups = {}) {
  const now = new Date();
  const start = getPeriodStart(period, now);
  const params = [];
  let where = "";
  if (start != null) {
    where = "WHERE timestamp >= ?";
    params.push(new Date(start).toISOString());
  }

  const rows = db.all(
    `SELECT timestamp, provider, model, connectionId, promptTokens, completionTokens, cost, status, tokens
     FROM usageHistory
     ${where}
     ORDER BY timestamp DESC`,
    params
  );
  const modelProviderMap = {};
  const providerTotals = {};
  const modelSet = new Set();

  for (const row of rows) {
    const model = row.model || "Unknown Model";
    const { provider, providerName } = resolveUsageProvider(row, providerLookups);
    const modelProviderKey = `${provider}\u0000${model}`;
    const tokens = parseJson(row.tokens, {}) || {};
    const promptTokens = getPromptTokens({ ...row, tokens });
    const completionTokens = getCompletionTokens({ ...row, tokens });
    const totalTokens = promptTokens + completionTokens;
    const cost = row.cost || 0;
    const error = getUsageError({ ...row, tokens });

    modelSet.add(model);
    if (!modelProviderMap[modelProviderKey]) {
      modelProviderMap[modelProviderKey] = createModelProviderRow(model, provider, providerName);
    }
    if (!modelProviderMap[modelProviderKey].providers[provider]) {
      modelProviderMap[modelProviderKey].providers[provider] = createProviderUsageRow(provider, providerName);
    }
    if (!providerTotals[provider]) providerTotals[provider] = createProviderUsageRow(provider, providerName);

    const modelRow = modelProviderMap[modelProviderKey];
    const providerRow = modelRow.providers[provider];
    const providerTotal = providerTotals[provider];
    for (const target of [modelRow, providerRow, providerTotal]) {
      target.totalRequests = (target.totalRequests || 0) + 1;
      target.requests = (target.requests || 0) + 1;
      target.promptTokens += promptTokens;
      target.completionTokens += completionTokens;
      target.totalTokens += totalTokens;
      target.cost += cost;
      if (error.isError) target.errorCount += 1;
      if (error.zeroTokenError) target.zeroTokenCount += 1;
      if (error.statusError) target.statusErrorCount += 1;
      if (row.timestamp && (!target.lastUsed || new Date(row.timestamp) > new Date(target.lastUsed))) {
        target.lastUsed = row.timestamp;
      }
    }
  }

  const models = Object.values(modelProviderMap)
    .map((modelRow) => {
      const providers = Object.values(modelRow.providers)
        .map(withErrorRate)
        .sort((a, b) => b.requests - a.requests || a.provider.localeCompare(b.provider));
      return withErrorRate({
        ...modelRow,
        providerCount: providers.length,
        providers,
      });
    })
    .sort((a, b) => b.totalRequests - a.totalRequests || a.provider.localeCompare(b.provider) || a.model.localeCompare(b.model))
    .slice(0, 80);

  const topProviders = Object.values(providerTotals)
    .map(withErrorRate)
    .sort((a, b) => b.requests - a.requests || a.provider.localeCompare(b.provider))
    .slice(0, 12);

  const totalRequests = rows.length;
  const totalErrors = Object.values(modelProviderMap).reduce((sum, row) => sum + (row.errorCount || 0), 0);

  return {
    period,
    totalModels: modelSet.size,
    totalModelProviderRows: Object.keys(modelProviderMap).length,
    totalProviders: Object.keys(providerTotals).length,
    totalRequests,
    totalErrors,
    errorRate: totalRequests > 0 ? totalErrors / totalRequests : 0,
    topProviders,
    models,
  };
}

export async function getUsageStats(period = "all") {
  const db = await getAdapter();

  const [{ getProviderConnections }, { getApiKeys }, { getProviderNodes }] = await Promise.all([
    import("./connectionsRepo.js"),
    import("./apiKeysRepo.js"),
    import("./nodesRepo.js"),
  ]);

  let allConnections = [];
  try { allConnections = await getProviderConnections(); } catch {}
  const connectionMap = {};
  for (const c of allConnections) connectionMap[c.id] = c.name || c.email || c.id;

  const providerNodes = [];
  try {
    const nodes = await getProviderNodes();
    providerNodes.push(...nodes);
  } catch {}
  const providerLookups = buildProviderLookups(allConnections, providerNodes);
  const providerNameMap = providerLookups.providerNameMap || {};

  let allApiKeys = [];
  try { allApiKeys = await getApiKeys(); } catch {}
  const apiKeyMap = {};
  for (const k of allApiKeys) apiKeyMap[k.key] = { name: k.name, id: k.id, createdAt: k.createdAt };

  const recentRows = db.all(
    `SELECT timestamp, provider, model, connectionId, promptTokens, completionTokens, tokens, status FROM usageHistory ORDER BY id DESC LIMIT ?`,
    [RECENT_HISTORY_SCAN_LIMIT]
  );
  const recentRequests = dedupeRecentRequests([
    ...recentRows.map((r) => toRecentRequest({ ...r, tokens: parseJson(r.tokens, {}) || {} }, providerLookups)),
    ...getRecentErrorDetailRequests(db, RECENT_REQUEST_LIMIT, providerLookups),
  ]);

  const stats = {
    totalRequests: 0,
    totalPromptTokens: 0, totalCompletionTokens: 0, totalCost: 0,
    byProvider: {}, byModel: {}, byAccount: {}, byApiKey: {}, byEndpoint: {},
    last10Minutes: [],
    pending: pendingRequests,
    activeRequests: [],
    recentRequests,
    errorCounts: getUsageErrorCounts(db, providerLookups),
    modelProviderUsage: getModelProviderUsage(db, period, providerLookups),
    errorProvider: (Date.now() - lastErrorProvider.ts < 10000) ? lastErrorProvider.provider : "",
  };

  // Active requests
  for (const [connectionId, models] of Object.entries(pendingRequests.byAccount)) {
    for (const [modelKey, count] of Object.entries(models)) {
      if (count > 0) {
        const accountName = connectionMap[connectionId] || `Account ${connectionId.slice(0, 8)}...`;
        const match = modelKey.match(/^(.*) \((.*)\)$/);
        stats.activeRequests.push({
          model: match ? match[1] : modelKey,
          provider: match ? match[2] : "unknown",
          account: accountName, count,
        });
      }
    }
  }

  // last10Minutes — query 10min window
  const now = new Date();
  const currentMinuteStart = new Date(Math.floor(now.getTime() / 60000) * 60000);
  const tenMinutesAgo = new Date(currentMinuteStart.getTime() - 9 * 60 * 1000);
  const bucketMap = {};
  for (let i = 0; i < 10; i++) {
    const ts = currentMinuteStart.getTime() - (9 - i) * 60 * 1000;
    bucketMap[ts] = { requests: 0, promptTokens: 0, completionTokens: 0, cost: 0 };
    stats.last10Minutes.push(bucketMap[ts]);
  }
  const recent10 = db.all(
    `SELECT timestamp, promptTokens, completionTokens, cost FROM usageHistory WHERE timestamp >= ? AND timestamp <= ?`,
    [tenMinutesAgo.toISOString(), now.toISOString()]
  );
  for (const r of recent10) {
    const tt = new Date(r.timestamp).getTime();
    const minuteStart = Math.floor(tt / 60000) * 60000;
    if (bucketMap[minuteStart]) {
      bucketMap[minuteStart].requests++;
      bucketMap[minuteStart].promptTokens += r.promptTokens || 0;
      bucketMap[minuteStart].completionTokens += r.completionTokens || 0;
      bucketMap[minuteStart].cost += r.cost || 0;
    }
  }

  const useDailySummary = period !== "24h" && period !== "today";

  if (useDailySummary) {
    const periodDays = { "7d": 7, "30d": 30, "60d": 60, "1y": 365 };
    const maxDays = periodDays[period] || null;
    const dayRows = loadDaysInRange(db, maxDays);

    for (const dr of dayRows) {
      const dateKey = dr.dateKey;
      const day = parseJson(dr.data, {});
      stats.totalPromptTokens += day.promptTokens || 0;
      stats.totalCompletionTokens += day.completionTokens || 0;
      stats.totalCost += day.cost || 0;

      for (const [prov, p] of Object.entries(day.byProvider || {})) {
        if (!stats.byProvider[prov]) stats.byProvider[prov] = { requests: 0, promptTokens: 0, completionTokens: 0, cost: 0 };
        stats.byProvider[prov].requests += p.requests || 0;
        stats.byProvider[prov].promptTokens += p.promptTokens || 0;
        stats.byProvider[prov].completionTokens += p.completionTokens || 0;
        stats.byProvider[prov].cost += p.cost || 0;
      }

      for (const [mk, m] of Object.entries(day.byModel || {})) {
        const rawModel = m.rawModel || mk.split("|")[0];
        const provider = m.provider || mk.split("|")[1] || "";
        const statsKey = provider ? `${rawModel} (${provider})` : rawModel;
        const providerDisplayName = getProviderDisplayName(provider, providerNameMap);
        if (!stats.byModel[statsKey]) {
          stats.byModel[statsKey] = { requests: 0, promptTokens: 0, completionTokens: 0, cost: 0, rawModel, provider: providerDisplayName, lastUsed: dateKey };
        }
        stats.byModel[statsKey].requests += m.requests || 0;
        stats.byModel[statsKey].promptTokens += m.promptTokens || 0;
        stats.byModel[statsKey].completionTokens += m.completionTokens || 0;
        stats.byModel[statsKey].cost += m.cost || 0;
        if (dateKey > (stats.byModel[statsKey].lastUsed || "")) stats.byModel[statsKey].lastUsed = dateKey;
      }

      for (const [connId, a] of Object.entries(day.byAccount || {})) {
        const accountName = connectionMap[connId] || `Account ${connId.slice(0, 8)}...`;
        const rawModel = a.rawModel || "";
        const provider = a.provider || "";
        const providerDisplayName = getProviderDisplayName(provider, providerNameMap);
        const accountKey = `${rawModel} (${provider} - ${accountName})`;
        if (!stats.byAccount[accountKey]) {
          stats.byAccount[accountKey] = { requests: 0, promptTokens: 0, completionTokens: 0, cost: 0, rawModel, provider: providerDisplayName, connectionId: connId, accountName, lastUsed: dateKey };
        }
        stats.byAccount[accountKey].requests += a.requests || 0;
        stats.byAccount[accountKey].promptTokens += a.promptTokens || 0;
        stats.byAccount[accountKey].completionTokens += a.completionTokens || 0;
        stats.byAccount[accountKey].cost += a.cost || 0;
        if (dateKey > (stats.byAccount[accountKey].lastUsed || "")) stats.byAccount[accountKey].lastUsed = dateKey;
      }

      for (const [akKey, ak] of Object.entries(day.byApiKey || {})) {
        const rawModel = ak.rawModel || "";
        const provider = ak.provider || "";
        const providerDisplayName = getProviderDisplayName(provider, providerNameMap);
        const apiKeyVal = ak.apiKey;
        const keyInfo = apiKeyVal ? apiKeyMap[apiKeyVal] : null;
        const keyName = keyInfo?.name || (apiKeyVal ? apiKeyVal.slice(0, 8) + "..." : "Local (No API Key)");
        const apiKeyMasked = maskApiKey(apiKeyVal);
        const apiKeyKey = apiKeyMasked || "local-no-key";
        if (!stats.byApiKey[akKey]) {
          stats.byApiKey[akKey] = { requests: 0, promptTokens: 0, completionTokens: 0, cost: 0, rawModel, provider: providerDisplayName, apiKeyMasked, keyName, apiKeyKey, lastUsed: dateKey };
        }
        stats.byApiKey[akKey].requests += ak.requests || 0;
        stats.byApiKey[akKey].promptTokens += ak.promptTokens || 0;
        stats.byApiKey[akKey].completionTokens += ak.completionTokens || 0;
        stats.byApiKey[akKey].cost += ak.cost || 0;
        if (dateKey > (stats.byApiKey[akKey].lastUsed || "")) stats.byApiKey[akKey].lastUsed = dateKey;
      }

      for (const [epKey, ep] of Object.entries(day.byEndpoint || {})) {
        const endpoint = ep.endpoint || epKey.split("|")[0] || "Unknown";
        const rawModel = ep.rawModel || "";
        const provider = ep.provider || "";
        const providerDisplayName = getProviderDisplayName(provider, providerNameMap);
        if (!stats.byEndpoint[epKey]) {
          stats.byEndpoint[epKey] = { requests: 0, promptTokens: 0, completionTokens: 0, cost: 0, endpoint, rawModel, provider: providerDisplayName, lastUsed: dateKey };
        }
        stats.byEndpoint[epKey].requests += ep.requests || 0;
        stats.byEndpoint[epKey].promptTokens += ep.promptTokens || 0;
        stats.byEndpoint[epKey].completionTokens += ep.completionTokens || 0;
        stats.byEndpoint[epKey].cost += ep.cost || 0;
        if (dateKey > (stats.byEndpoint[epKey].lastUsed || "")) stats.byEndpoint[epKey].lastUsed = dateKey;
      }
    }

    // Overlay precise lastUsed timestamps from history
    const overlayCutoff = maxDays ? Date.now() - maxDays * 86400000 : 0;
    const histRows = db.all(
      `SELECT timestamp, provider, model, connectionId, apiKey, endpoint FROM usageHistory WHERE timestamp >= ?`,
      [new Date(overlayCutoff).toISOString()]
    );
    for (const e of histRows) {
      const ts = e.timestamp;
      const modelKey = e.provider ? `${e.model} (${e.provider})` : e.model;
      if (stats.byModel[modelKey] && new Date(ts) > new Date(stats.byModel[modelKey].lastUsed)) stats.byModel[modelKey].lastUsed = ts;

      if (e.connectionId) {
        const accountName = connectionMap[e.connectionId] || `Account ${e.connectionId.slice(0, 8)}...`;
        const accountKey = `${e.model} (${e.provider} - ${accountName})`;
        if (stats.byAccount[accountKey] && new Date(ts) > new Date(stats.byAccount[accountKey].lastUsed)) stats.byAccount[accountKey].lastUsed = ts;
      }

      const apiKeyKey = (e.apiKey && typeof e.apiKey === "string")
        ? `${e.apiKey}|${e.model}|${e.provider || "unknown"}`
        : "local-no-key";
      if (stats.byApiKey[apiKeyKey] && new Date(ts) > new Date(stats.byApiKey[apiKeyKey].lastUsed)) stats.byApiKey[apiKeyKey].lastUsed = ts;

      const endpoint = e.endpoint || "Unknown";
      const endpointKey = `${endpoint}|${e.model}|${e.provider || "unknown"}`;
      if (stats.byEndpoint[endpointKey] && new Date(ts) > new Date(stats.byEndpoint[endpointKey].lastUsed)) stats.byEndpoint[endpointKey].lastUsed = ts;
    }
  } else {
    // 24h / today: live history
    let cutoff;
    if (period === "today") {
      const startOfDay = new Date();
      startOfDay.setHours(0, 0, 0, 0);
      cutoff = startOfDay.toISOString();
    } else {
      cutoff = new Date(Date.now() - PERIOD_MS["24h"]).toISOString();
    }
    const filtered = db.all(
      `SELECT timestamp, provider, model, connectionId, apiKey, endpoint, promptTokens, completionTokens, cost, tokens FROM usageHistory WHERE timestamp >= ?`,
      [cutoff]
    );

    for (const r of filtered) {
      const tokens = parseJson(r.tokens, {}) || {};
      const promptTokens = getPromptTokens({ ...r, tokens });
      const completionTokens = getCompletionTokens({ ...r, tokens });
      const entryCost = r.cost || 0;
      const providerDisplayName = getProviderDisplayName(r.provider, providerNameMap);

      stats.totalPromptTokens += promptTokens;
      stats.totalCompletionTokens += completionTokens;
      stats.totalCost += entryCost;

      if (!stats.byProvider[r.provider]) stats.byProvider[r.provider] = { requests: 0, promptTokens: 0, completionTokens: 0, cost: 0 };
      stats.byProvider[r.provider].requests++;
      stats.byProvider[r.provider].promptTokens += promptTokens;
      stats.byProvider[r.provider].completionTokens += completionTokens;
      stats.byProvider[r.provider].cost += entryCost;

      const modelKey = r.provider ? `${r.model} (${r.provider})` : r.model;
      if (!stats.byModel[modelKey]) {
        stats.byModel[modelKey] = { requests: 0, promptTokens: 0, completionTokens: 0, cost: 0, rawModel: r.model, provider: providerDisplayName, lastUsed: r.timestamp };
      }
      stats.byModel[modelKey].requests++;
      stats.byModel[modelKey].promptTokens += promptTokens;
      stats.byModel[modelKey].completionTokens += completionTokens;
      stats.byModel[modelKey].cost += entryCost;
      if (new Date(r.timestamp) > new Date(stats.byModel[modelKey].lastUsed)) stats.byModel[modelKey].lastUsed = r.timestamp;

      if (r.connectionId) {
        const accountName = connectionMap[r.connectionId] || `Account ${r.connectionId.slice(0, 8)}...`;
        const accountKey = `${r.model} (${r.provider} - ${accountName})`;
        if (!stats.byAccount[accountKey]) {
          stats.byAccount[accountKey] = { requests: 0, promptTokens: 0, completionTokens: 0, cost: 0, rawModel: r.model, provider: providerDisplayName, connectionId: r.connectionId, accountName, lastUsed: r.timestamp };
        }
        stats.byAccount[accountKey].requests++;
        stats.byAccount[accountKey].promptTokens += promptTokens;
        stats.byAccount[accountKey].completionTokens += completionTokens;
        stats.byAccount[accountKey].cost += entryCost;
        if (new Date(r.timestamp) > new Date(stats.byAccount[accountKey].lastUsed)) stats.byAccount[accountKey].lastUsed = r.timestamp;
      }

      if (r.apiKey && typeof r.apiKey === "string") {
        const keyInfo = apiKeyMap[r.apiKey];
        const keyName = keyInfo?.name || r.apiKey.slice(0, 8) + "...";
        const apiKeyMasked = maskApiKey(r.apiKey);
        const akKey = `${apiKeyMasked}|${r.model}|${r.provider || "unknown"}`;
        if (!stats.byApiKey[akKey]) {
          stats.byApiKey[akKey] = { requests: 0, promptTokens: 0, completionTokens: 0, cost: 0, rawModel: r.model, provider: providerDisplayName, apiKeyMasked, keyName, apiKeyKey: apiKeyMasked, lastUsed: r.timestamp };
        }
        const ake = stats.byApiKey[akKey];
        ake.requests++; ake.promptTokens += promptTokens; ake.completionTokens += completionTokens; ake.cost += entryCost;
        if (new Date(r.timestamp) > new Date(ake.lastUsed)) ake.lastUsed = r.timestamp;
      } else {
        if (!stats.byApiKey["local-no-key"]) {
          stats.byApiKey["local-no-key"] = { requests: 0, promptTokens: 0, completionTokens: 0, cost: 0, rawModel: r.model, provider: providerDisplayName, apiKeyMasked: null, keyName: "Local (No API Key)", apiKeyKey: "local-no-key", lastUsed: r.timestamp };
        }
        const ake = stats.byApiKey["local-no-key"];
        ake.requests++; ake.promptTokens += promptTokens; ake.completionTokens += completionTokens; ake.cost += entryCost;
        if (new Date(r.timestamp) > new Date(ake.lastUsed)) ake.lastUsed = r.timestamp;
      }

      const endpoint = r.endpoint || "Unknown";
      const epKey = `${endpoint}|${r.model}|${r.provider || "unknown"}`;
      if (!stats.byEndpoint[epKey]) {
        stats.byEndpoint[epKey] = { requests: 0, promptTokens: 0, completionTokens: 0, cost: 0, endpoint, rawModel: r.model, provider: providerDisplayName, lastUsed: r.timestamp };
      }
      const epe = stats.byEndpoint[epKey];
      epe.requests++; epe.promptTokens += promptTokens; epe.completionTokens += completionTokens; epe.cost += entryCost;
      if (new Date(r.timestamp) > new Date(epe.lastUsed)) epe.lastUsed = r.timestamp;
    }
  }

  stats.totalRequests = Object.values(stats.byProvider).reduce((sum, p) => sum + (p.requests || 0), 0);
  return stats;
}

export async function getChartData(period = "7d") {
  const db = await getAdapter();
  const now = Date.now();

  if (period === "today") {
    const bucketCount = 24;
    const bucketMs = 3600000;
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const startTime = startOfDay.getTime();
    const endTime = startTime + bucketCount * bucketMs;
    const labelFn = (ts) => new Date(ts).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false });
    const buckets = Array.from({ length: bucketCount }, (_, i) => ({ label: labelFn(startTime + i * bucketMs), tokens: 0, cost: 0 }));

    const rows = db.all(
      `SELECT timestamp, promptTokens, completionTokens, cost FROM usageHistory WHERE timestamp >= ?`,
      [new Date(startTime).toISOString()]
    );
    for (const r of rows) {
      const t = new Date(r.timestamp).getTime();
      if (t < startTime || t >= endTime) continue;
      const idx = Math.floor((t - startTime) / bucketMs);
      if (idx >= 0 && idx < bucketCount) {
        buckets[idx].tokens += (r.promptTokens || 0) + (r.completionTokens || 0);
        buckets[idx].cost += r.cost || 0;
      }
    }
    return buckets;
  }

  if (period === "24h") {
    const bucketCount = 24;
    const bucketMs = 3600000;
    const labelFn = (ts) => new Date(ts).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false });
    const startTime = now - bucketCount * bucketMs;
    const buckets = Array.from({ length: bucketCount }, (_, i) => ({ label: labelFn(startTime + i * bucketMs), tokens: 0, cost: 0 }));

    const rows = db.all(
      `SELECT timestamp, promptTokens, completionTokens, cost FROM usageHistory WHERE timestamp >= ?`,
      [new Date(startTime).toISOString()]
    );
    for (const r of rows) {
      const t = new Date(r.timestamp).getTime();
      if (t < startTime || t > now) continue;
      const idx = Math.min(Math.floor((t - startTime) / bucketMs), bucketCount - 1);
      buckets[idx].tokens += (r.promptTokens || 0) + (r.completionTokens || 0);
      buckets[idx].cost += r.cost || 0;
    }
    return buckets;
  }

  if (period === "1y" || period === "all") {
    const dayRows = period === "1y" ? loadDaysInRange(db, 365) : loadDaysInRange(db, null);
    const monthMap = {};
    for (const row of dayRows) {
      const dayData = parseJson(row.data, {});
      const monthKey = String(row.dateKey || "").slice(0, 7);
      if (!monthKey) continue;
      if (!monthMap[monthKey]) monthMap[monthKey] = { tokens: 0, cost: 0 };
      monthMap[monthKey].tokens += (dayData.promptTokens || 0) + (dayData.completionTokens || 0);
      monthMap[monthKey].cost += dayData.cost || 0;
    }

    return Object.entries(monthMap)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([monthKey, data]) => {
        const [year, month] = monthKey.split("-").map(Number);
        const d = new Date(year, (month || 1) - 1, 1);
        return {
          label: d.toLocaleDateString("en-US", { month: "short", year: "2-digit" }),
          tokens: data.tokens,
          cost: data.cost,
        };
      });
  }

  const bucketCount = period === "7d" ? 7 : period === "30d" ? 30 : 60;
  const today = new Date();
  const labelFn = (d) => d.toLocaleDateString("en-US", { month: "short", day: "numeric" });

  // Build map of dateKey → day data
  const dayRows = loadDaysInRange(db, bucketCount);
  const dayMap = {};
  for (const r of dayRows) dayMap[r.dateKey] = parseJson(r.data, {});

  return Array.from({ length: bucketCount }, (_, i) => {
    const d = new Date(today);
    d.setDate(d.getDate() - (bucketCount - 1 - i));
    const dateKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    const dayData = dayMap[dateKey];
    return {
      label: labelFn(d),
      tokens: dayData ? (dayData.promptTokens || 0) + (dayData.completionTokens || 0) : 0,
      cost: dayData ? (dayData.cost || 0) : 0,
    };
  });
}

function formatLogDate(date = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(date.getDate())}-${pad(date.getMonth() + 1)}-${date.getFullYear()} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

// No-op: request log is now derived from usageHistory table on read.
export async function appendRequestLog() {}

export async function getRecentLogs(limit = 200) {
  try {
    const db = await getAdapter();
    const rows = db.all(
      `SELECT timestamp, provider, model, connectionId, promptTokens, completionTokens, status, tokens FROM usageHistory ORDER BY id DESC LIMIT ?`,
      [limit],
    );
    if (!rows.length) return [];

    const connMap = {};
    try {
      const { getProviderConnections } = await import("./connectionsRepo.js");
      const connections = await getProviderConnections();
      for (const c of connections) connMap[c.id] = c.name || c.email || "";
    } catch {}

    return rows.map((r) => {
      const ts = formatLogDate(new Date(r.timestamp));
      const p = r.provider?.toUpperCase() || "-";
      const m = r.model || "-";
      const account = connMap[r.connectionId] || (r.connectionId ? r.connectionId.slice(0, 8) : "-");
      const tk = r.tokens ? parseJson(r.tokens, {}) : {};
      const sent = r.promptTokens ?? tk.prompt_tokens ?? tk.input_tokens ?? "-";
      const received = r.completionTokens ?? tk.completion_tokens ?? tk.output_tokens ?? "-";
      return `${ts} | ${m} | ${p} | ${account} | ${sent} | ${received} | ${r.status || "-"}`;
    });
  } catch (e) {
    console.error("[usageRepo] getRecentLogs failed:", e.message);
    return [];
  }
}
