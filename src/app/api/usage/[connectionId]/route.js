// Ensure proxyFetch is loaded to patch globalThis.fetch
import "open-sse/index.js";

import { getProviderConnectionById, getUsageHistory, updateProviderConnection } from "@/lib/localDb";
import { getUsageForProvider } from "open-sse/services/usage.js";
import { getExecutor } from "open-sse/executors/index.js";
import { resolveConnectionProxyConfig } from "@/lib/network/connectionProxy";
import { USAGE_APIKEY_PROVIDERS } from "@/shared/constants/providers";

// Detect auth-expired messages returned by usage providers instead of throwing
const AUTH_EXPIRED_PATTERNS = ["expired", "authentication", "unauthorized", "401", "re-authorize"];
function isAuthExpiredMessage(usage) {
  if (!usage?.message) return false;
  const msg = usage.message.toLowerCase();
  return AUTH_EXPIRED_PATTERNS.some((p) => msg.includes(p));
}

const ANTIGRAVITY_LOCAL_USAGE_TOKEN_UNIT = 1000;
const ANTIGRAVITY_LOCAL_USAGE_REQUEST_UNIT = 25;

function getAntigravityQuotaWindowStart(usage) {
  const resetTimes = Object.values(usage?.quotas || {})
    .map((quota) => quota?.resetAt ? new Date(quota.resetAt).getTime() : null)
    .filter((time) => Number.isFinite(time));
  if (resetTimes.length > 0) {
    return new Date(Math.min(...resetTimes) - 24 * 60 * 60 * 1000).toISOString();
  }
  return new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
}

function normalizeAntigravityModelId(model) {
  return String(model || "")
    .replace(/^antigravity\//, "")
    .replace(/^ag\//, "")
    .replace(/^models\//, "");
}

function getUsageEntryTotalTokens(entry) {
  const tokens = entry?.tokens || {};
  const total = Number(tokens.total_tokens ?? tokens.totalTokens);
  if (Number.isFinite(total) && total > 0) return total;
  const prompt = Number(tokens.prompt_tokens ?? tokens.promptTokens) || 0;
  const completion = Number(tokens.completion_tokens ?? tokens.completionTokens) || 0;
  return prompt + completion;
}

async function applyAntigravityLocalUsageOverlay(connection, usage) {
  if (connection.provider !== "antigravity" || !usage?.quotas) return usage;

  const startDate = getAntigravityQuotaWindowStart(usage);
  const history = await getUsageHistory({
    provider: "antigravity",
    startDate,
  });

  const localUsageByModel = {};
  const seen = new Set();
  for (const entry of history || []) {
    if (entry.connectionId !== connection.id) continue;
    if (entry.status && !["ok", "success"].includes(String(entry.status).toLowerCase())) continue;

    const modelKey = normalizeAntigravityModelId(entry.model);
    if (!modelKey) continue;

    const totalTokens = getUsageEntryTotalTokens(entry);
    const minute = entry.timestamp ? String(entry.timestamp).slice(0, 16) : "";
    const exactTime = entry.timestamp || "";
    const dedupeKey = totalTokens > 0
      ? `${modelKey}|${totalTokens}|${minute}`
      : `${modelKey}|0|${exactTime}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    if (!localUsageByModel[modelKey]) localUsageByModel[modelKey] = { tokens: 0, requests: 0 };
    localUsageByModel[modelKey].tokens += Math.max(0, totalTokens);
    localUsageByModel[modelKey].requests += 1;
  }

  if (Object.keys(localUsageByModel).length === 0) return usage;

  const quotas = { ...usage.quotas };
  for (const [quotaKey, quota] of Object.entries(quotas)) {
    const localUsage = localUsageByModel[quotaKey];
    if (!localUsage) continue;

    const total = Number(quota.total) > 0 ? Number(quota.total) : 1000;
    const providerUsed = Number(quota.used) || 0;
    const providerRemaining = Number(quota.remainingPercentage);
    const upstreamLooksStale = providerUsed <= 0
      && (!Number.isFinite(providerRemaining) || providerRemaining >= 99.9);
    if (!upstreamLooksStale) continue;

    const tokenUsed = Math.ceil(localUsage.tokens / ANTIGRAVITY_LOCAL_USAGE_TOKEN_UNIT);
    const requestUsed = Math.ceil(localUsage.requests / ANTIGRAVITY_LOCAL_USAGE_REQUEST_UNIT);
    const localUsed = Math.min(total, Math.max(tokenUsed, requestUsed));
    if (localUsed <= providerUsed) continue;

    const used = localUsed;
    const remainingPercentage = Math.max(0, ((total - used) / total) * 100);
    quotas[quotaKey] = {
      ...quota,
      used,
      total,
      remainingPercentage: Math.min(
        Number.isFinite(Number(quota.remainingPercentage)) ? Number(quota.remainingPercentage) : 100,
        remainingPercentage,
      ),
      localUsageOverlay: {
        tokenUnit: ANTIGRAVITY_LOCAL_USAGE_TOKEN_UNIT,
        requestUnit: ANTIGRAVITY_LOCAL_USAGE_REQUEST_UNIT,
        tokens: localUsage.tokens,
        requests: localUsage.requests,
        usedUnits: used,
        since: startDate,
      },
    };
  }

  return { ...usage, quotas };
}

/**
 * Refresh credentials using executor and update database
 * @param {boolean} force - Skip needsRefresh check and always attempt refresh
 * @returns Promise<{ connection, refreshed: boolean }>
 */
export async function refreshAndUpdateCredentials(connection, force = false, proxyOptions = null) {
  const executor = getExecutor(connection.provider);

  // Build credentials object from connection
  const credentials = {
    accessToken: connection.accessToken,
    refreshToken: connection.refreshToken,
    idToken: connection.idToken,
    expiresAt: connection.expiresAt || connection.tokenExpiresAt,
    lastRefreshAt: connection.lastRefreshAt,
    connectionId: connection.id,
    providerSpecificData: connection.providerSpecificData,
    // For GitHub
    copilotToken: connection.providerSpecificData?.copilotToken,
    copilotTokenExpiresAt: connection.providerSpecificData?.copilotTokenExpiresAt,
  };

  // Check if refresh is needed (skip when force=true)
  const needsRefresh = force || executor.needsRefresh(credentials);

  if (!needsRefresh) {
    return { connection, refreshed: false };
  }

  // Use executor's refreshCredentials method (with optional proxy)
  const refreshResult = await executor.refreshCredentials(credentials, console, proxyOptions);

  if (!refreshResult) {
    // Refresh failed but we still have an accessToken — try with existing token
    if (connection.accessToken) {
      return { connection, refreshed: false };
    }
    throw new Error("Failed to refresh credentials. Please re-authorize the connection.");
  }

  // Build update object
  const now = new Date().toISOString();
  const updateData = {
    updatedAt: now,
  };

  // Update accessToken if present
  if (refreshResult.accessToken) {
    updateData.accessToken = refreshResult.accessToken;
  }

  // Update refreshToken if present
  if (refreshResult.refreshToken) {
    updateData.refreshToken = refreshResult.refreshToken;
  }

  if (refreshResult.idToken) {
    updateData.idToken = refreshResult.idToken;
  }

  if (refreshResult.lastRefreshAt) {
    updateData.lastRefreshAt = refreshResult.lastRefreshAt;
  }

  // Update token expiry
  if (refreshResult.expiresIn) {
    updateData.expiresAt = new Date(Date.now() + refreshResult.expiresIn * 1000).toISOString();
    updateData.expiresIn = refreshResult.expiresIn;
  } else if (refreshResult.expiresAt) {
    updateData.expiresAt = refreshResult.expiresAt;
  }

  // Handle provider-specific data (copilotToken for GitHub, etc.)
  const providerSpecificUpdates = {
    ...(refreshResult.providerSpecificData || {}),
    ...(refreshResult.copilotToken ? { copilotToken: refreshResult.copilotToken } : {}),
    ...(refreshResult.copilotTokenExpiresAt ? { copilotTokenExpiresAt: refreshResult.copilotTokenExpiresAt } : {}),
  };
  if (Object.keys(providerSpecificUpdates).length > 0) {
    updateData.providerSpecificData = {
      ...(connection.providerSpecificData || {}),
      ...providerSpecificUpdates,
    };
  }

  // Update database
  await updateProviderConnection(connection.id, updateData);

  // Return updated connection
  const updatedConnection = {
    ...connection,
    ...updateData,
    providerSpecificData: updateData.providerSpecificData || connection.providerSpecificData,
  };

  return {
    connection: updatedConnection,
    refreshed: true,
  };
}

/**
 * GET /api/usage/[connectionId] - Get usage data for a specific connection
 */
export async function GET(request, { params }) {
  let connection;
  try {
    const { connectionId } = await params;


    // Get connection from database
    connection = await getProviderConnectionById(connectionId);
    if (!connection) {
      return Response.json({ error: "Connection not found" }, { status: 404 });
    }

    // Allow OAuth connections, plus whitelisted apikey providers (glm/minimax/kiro/...)
    // Kiro's headless api-key flow persists authType "api_key" (underscore) while
    // generic apikey providers persist "apikey" — accept both spellings here.
    const isOAuth = connection.authType === "oauth";
    const isApikeyAuth =
      connection.authType === "apikey" || connection.authType === "api_key";
    const isApikeyEligible =
      isApikeyAuth && USAGE_APIKEY_PROVIDERS.includes(connection.provider);

    if (!isOAuth && !isApikeyEligible) {
      return Response.json({ message: "Usage not available for this connection" });
    }

    // Resolve connection proxy config; force strictProxy=false so quota/refresh fall back to direct on failure
    const proxyConfig = await resolveConnectionProxyConfig(connection.providerSpecificData);
    const proxyOptions = {
      connectionProxyEnabled: proxyConfig.connectionProxyEnabled === true,
      connectionProxyUrl: proxyConfig.connectionProxyUrl || "",
      connectionNoProxy: proxyConfig.connectionNoProxy || "",
      vercelRelayUrl: proxyConfig.vercelRelayUrl || "",
      strictProxy: false,
    };

    // Refresh credentials only for OAuth connections (apikey has no token refresh)
    if (isOAuth) {
      try {
        const result = await refreshAndUpdateCredentials(connection, false, proxyOptions);
        connection = result.connection;
      } catch (refreshError) {
        console.error("[Usage API] Credential refresh failed:", refreshError);
        return Response.json({
          error: `Credential refresh failed: ${refreshError.message}`
        }, { status: 401 });
      }
    }

    // Fetch usage from provider API
    let usage = await getUsageForProvider(connection, proxyOptions);
    usage = await applyAntigravityLocalUsageOverlay(connection, usage);

    // If provider returned an auth-expired message instead of throwing,
    // force-refresh token and retry once (OAuth only)
    if (isOAuth && isAuthExpiredMessage(usage) && connection.refreshToken) {
      try {
        const retryResult = await refreshAndUpdateCredentials(connection, true, proxyOptions);
        connection = retryResult.connection;
        usage = await getUsageForProvider(connection, proxyOptions);
        usage = await applyAntigravityLocalUsageOverlay(connection, usage);
      } catch (retryError) {
        console.warn(`[Usage] ${connection.provider}: force refresh failed: ${retryError.message}`);
      }
    }

    return Response.json(usage);
  } catch (error) {
    const provider = connection?.provider ?? "unknown";
    console.warn(`[Usage] ${provider}: ${error.message}`);
    return Response.json({ error: error.message }, { status: 500 });
  }
}
