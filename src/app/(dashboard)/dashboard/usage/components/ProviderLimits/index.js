"use client";

import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import ProviderIcon from "@/shared/components/ProviderIcon";
import Toggle from "@/shared/components/Toggle";
import Tooltip from "@/shared/components/Tooltip";
import {
  parseQuotaData,
  calculatePercentage,
  getRemainingPercentage,
  formatResetTime,
  getConnectionLabel,
  getConnectionQuotaRemaining,
  sortVisibleConnections,
  buildLoadingState,
  filterQuotaStateByConnections,
  getConnectionsEmptyMessage,
  getPageSizeLabel,
  getConnectionsPaginationSummary,
  getSafePagination,
  getSafeTotals,
  shouldResetPage,
  getPaginationPageValue,
  getProviderOptions,
  reconcileConnectionsPage,
  getQuotaCache,
  setQuotaCache,
  QUOTA_CACHE_KEY,
  REFRESH_INTERVAL_MS,
  AUTO_REFRESH_SECONDS,
  CLAUDE_REFRESH_INTERVAL_MS,
  DEPLETED_QUOTA_THRESHOLD,
  AUTO_REFRESH_STORAGE_KEY,
  CONNECTIONS_PAGE_SIZE,
  ACCOUNT_PAGE_SIZE_OPTIONS,
  ACCOUNT_PAGE_SIZE_MAX,
  ACCOUNT_FILTER_OPTIONS,
  QUOTA_SORT_OPTIONS,
} from "./utils";
import Card from "@/shared/components/Card";
import { ConfirmModal, EditConnectionModal } from "@/shared/components";
import { USAGE_SUPPORTED_PROVIDERS } from "@/shared/constants/providers";
import { useCopyToClipboard } from "@/shared/hooks/useCopyToClipboard";

// Maps the stored providerSpecificData.authMethod to a human label for Kiro.
// Values come from the Kiro connect flows: builder-id/idc (device code),
// google/github (social), imported (refresh-token paste), api_key (headless).
const KIRO_METHOD_LABELS = {
  "builder-id": "AWS Builder ID",
  idc: "IAM Identity Center",
  google: "Google",
  github: "GitHub",
  imported: "Imported Token",
  api_key: "API Key",
};

const AUTO_PING_SETTINGS_KEYS = {
  claude: "claudeAutoPing",
  codex: "codexAutoPing",
};

const AUTO_PING_TOOLTIPS = {
  claude: "When your 5h quota runs out, auto-sends a request the moment it resets so a new window starts right away.",
  codex: "Auto-starts the next 5h Codex window after reset by sending a tiny gpt-5.5 request. Consumes a small amount of quota.",
};

function kiroMethodLabel(conn) {
  const m = conn.providerSpecificData?.authMethod;
  if (m && KIRO_METHOD_LABELS[m]) return KIRO_METHOD_LABELS[m];
  return conn.authType === "api_key" ? "API Key" : "OAuth";
}

function getConnectionSecondaryLabel(connection) {
  if (connection.name?.trim() && connection.email?.trim() && connection.name.trim() !== connection.email.trim()) {
    return connection.email.trim();
  }

  if (connection.name?.trim() && connection.displayName?.trim() && connection.name.trim() !== connection.displayName.trim()) {
    return connection.displayName.trim();
  }

  return null;
}

// Region is stored for builder-id/idc/api_key flows; social and imported flows
// omit it, so fall back to the region segment of the profileArn
// (arn:aws:codewhisperer:<region>:...).
function kiroRegion(conn) {
  const r = conn.providerSpecificData?.region;
  if (r) return r;
  const arn = conn.providerSpecificData?.profileArn;
  const seg = typeof arn === "string" ? arn.split(":")[3] : "";
  return seg || "";
}

function getCodexResetCreditCount(quota) {
  const value = quota?.raw?.resetCredits?.availableCount;
  const count = typeof value === "number" ? value : Number(value);
  return Number.isFinite(count) ? Math.max(0, count) : 0;
}

function getProviderColor(provider) {
  const colors = {
    github: "#111827",
    antigravity: "#4285F4",
    codex: "#10A37F",
    kiro: "#FF9900",
    qoder: "#EC4899",
    claude: "#D97757",
    "gemini-cli": "#3B82F6",
  };
  return colors[provider?.toLowerCase()] || "#64748B";
}

function getQuotaTone(remaining) {
  if (remaining > 70) {
    return {
      label: "Healthy",
      text: "text-emerald-600 dark:text-emerald-400",
      bg: "bg-emerald-500",
      soft: "bg-emerald-500/10",
      border: "border-emerald-500/30",
    };
  }
  if (remaining >= 30) {
    return {
      label: "Watch",
      text: "text-amber-600 dark:text-amber-400",
      bg: "bg-amber-500",
      soft: "bg-amber-500/10",
      border: "border-amber-500/30",
    };
  }
  return {
    label: "Low",
    text: "text-red-600 dark:text-red-400",
    bg: "bg-red-500",
    soft: "bg-red-500/10",
    border: "border-red-500/30",
  };
}

function getConnectionQuotaStats(connection, quotaData) {
  const quotas = quotaData[connection.id]?.quotas || [];
  const remainingValues = quotas.map((quota) => getRemainingPercentage(quota));
  const remaining = remainingValues.length
    ? Math.min(...remainingValues)
    : Number.POSITIVE_INFINITY;
  const resetTimes = quotas
    .map((quota) => (quota.resetAt ? new Date(quota.resetAt).getTime() : null))
    .filter((time) => Number.isFinite(time));
  return {
    quotas,
    remaining,
    earliestReset: resetTimes.length
      ? Math.min(...resetTimes)
      : Number.POSITIVE_INFINITY,
  };
}

function sortConnectionsForProvider(connections, quotaData, quotaSortMode, expiringFirst) {
  return [...connections].sort((a, b) => {
    const activeDiff = Number(b.isActive !== false) - Number(a.isActive !== false);
    if (activeDiff !== 0) return activeDiff;

    const statsA = getConnectionQuotaStats(a, quotaData);
    const statsB = getConnectionQuotaStats(b, quotaData);

    if (expiringFirst) {
      const resetDiff = statsA.earliestReset - statsB.earliestReset;
      if (resetDiff !== 0) return resetDiff;
    }

    if (quotaSortMode === "remaining-desc") {
      const remainingDiff = statsB.remaining - statsA.remaining;
      if (remainingDiff !== 0) return remainingDiff;
    } else {
      const remainingDiff = statsA.remaining - statsB.remaining;
      if (remainingDiff !== 0) return remainingDiff;
    }

    return (getConnectionLabel(a) || "").localeCompare(getConnectionLabel(b) || "");
  });
}

function buildProviderGroups(connections, quotaData, quotaSortMode, expiringFirst) {
  const grouped = new Map();

  connections.forEach((connection) => {
    const provider = connection.provider || "unknown";
    if (!grouped.has(provider)) {
      grouped.set(provider, {
        provider,
        connections: [],
      });
    }
    grouped.get(provider).connections.push(connection);
  });

  return Array.from(grouped.values())
    .map((group) => {
      const sortedGroupConnections = sortConnectionsForProvider(
        group.connections,
        quotaData,
        quotaSortMode,
        expiringFirst,
      );
      const activeCount = sortedGroupConnections.filter((conn) => conn.isActive !== false).length;
      const remainingValues = sortedGroupConnections
        .map((conn) => getConnectionQuotaStats(conn, quotaData).remaining)
        .filter((value) => Number.isFinite(value));

      return {
        ...group,
        connections: sortedGroupConnections,
        activeCount,
        lowestRemaining: remainingValues.length
          ? Math.min(...remainingValues)
          : Number.POSITIVE_INFINITY,
      };
    })
    .sort((a, b) => {
      const remainingDiff = a.lowestRemaining - b.lowestRemaining;
      if (remainingDiff !== 0) return remainingDiff;
      return a.provider.localeCompare(b.provider);
    });
}

function QuotaMetricRow({ quota }) {
  const remaining = getRemainingPercentage(quota);
  const tone = getQuotaTone(remaining);
  const unlimited = !quota.total || quota.total <= 0;
  const resetCountdown = formatResetTime(quota.resetAt);
  const totalLabel = unlimited ? "Unlimited" : Number(quota.total || 0).toLocaleString();
  const usedLabel = Number(quota.used || 0).toLocaleString();
  const unit = quota.unit ? ` ${quota.unit}` : "";

  return (
    <div className="grid min-w-0 grid-cols-[minmax(95px,1fr)_minmax(130px,1.55fr)_auto] items-center gap-2 border-b border-black/5 px-2 py-1.5 last:border-b-0 dark:border-white/5">
      <div className="flex min-w-0 items-center gap-1.5">
        <span className={`size-2 shrink-0 rounded-full ${tone.bg}`} />
        <div className="min-w-0">
          <div className="truncate text-[11px] font-semibold leading-tight text-text-primary" title={quota.name}>
            {quota.name}
          </div>
          <div className="text-[10px] leading-tight text-text-muted">
            {usedLabel} / {totalLabel}{unit}
          </div>
        </div>
      </div>
      <div className="min-w-0">
        {!unlimited && (
          <div className={`h-1 overflow-hidden rounded-full ${tone.soft}`}>
            <div
              className={`h-full rounded-full transition-all duration-300 ${tone.bg}`}
              style={{ width: `${Math.min(Math.max(remaining, 0), 100)}%` }}
            />
          </div>
        )}
        <div className="mt-0.5 flex min-w-0 items-center justify-between gap-2 text-[10px] leading-tight">
          <span className={`font-semibold ${tone.text}`}>
            {unlimited ? "Unlimited" : `${remaining}%`}
          </span>
          {resetCountdown !== "-" && (
            <span className="truncate text-text-muted">
              in {resetCountdown}
            </span>
          )}
        </div>
      </div>
      <div className={`rounded-full px-1.5 py-0.5 text-[9px] font-semibold leading-none ${tone.soft} ${tone.text}`}>
        {tone.label}
      </div>
    </div>
  );
}

export default function ProviderLimits() {
  const { copied, copy } = useCopyToClipboard();
  const [connections, setConnections] = useState([]);
  const [quotaData, setQuotaData] = useState({});
  const [loading, setLoading] = useState({});
  const [errors, setErrors] = useState({});
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [autoPingMaps, setAutoPingMaps] = useState({ claude: {}, codex: {} });
  const [lastUpdated, setLastUpdated] = useState(null);
  const [hasHydratedAutoRefresh, setHasHydratedAutoRefresh] = useState(false);
  const [refreshingAll, setRefreshingAll] = useState(false);
  const [countdown, setCountdown] = useState(AUTO_REFRESH_SECONDS);
  const [connectionsLoading, setConnectionsLoading] = useState(true);
  const [deletingId, setDeletingId] = useState(null);
  const [togglingId, setTogglingId] = useState(null);
  const [refreshingQuotaIds, setRefreshingQuotaIds] = useState(() => new Set());
  const [resettingLimitId, setResettingLimitId] = useState(null);
  const [resetConfirmState, setResetConfirmState] = useState(null);
  const [showEditModal, setShowEditModal] = useState(false);
  const [selectedConnection, setSelectedConnection] = useState(null);
  const [proxyPools, setProxyPools] = useState([]);
  const [providerFilter, setProviderFilter] = useState("all");
  const [providerOptions, setProviderOptions] = useState([]);
  const [accountFilter, setAccountFilter] = useState("all");
  const [quotaSortMode, setQuotaSortMode] = useState("default");
  const [expiringFirst, setExpiringFirst] = useState(false);
  const [providerMenuOpen, setProviderMenuOpen] = useState(false);
  const [bulkToggling, setBulkToggling] = useState(false);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(CONNECTIONS_PAGE_SIZE);
  const [customPageSizeInput, setCustomPageSizeInput] = useState(
    String(CONNECTIONS_PAGE_SIZE),
  );
  const [pagination, setPagination] = useState({
    page: 1,
    pageSize: CONNECTIONS_PAGE_SIZE,
    total: 0,
    totalPages: 1,
  });
  const [totals, setTotals] = useState({
    eligibleConnections: 0,
    providerFilteredConnections: 0,
  });

  const intervalRef = useRef(null);
  const countdownRef = useRef(null);
  const tickCountRef = useRef(0);
  const refreshingAllRef = useRef(false);

  const fetchConnections = useCallback(
    async (targetPage = page) => {
      try {
        const params = new URLSearchParams({
          page: String(targetPage),
          pageSize: String(pageSize),
          accountStatus: accountFilter,
          sort: "priority",
        });

        if (providerFilter !== "all") {
          params.set("provider", providerFilter);
        }

        const response = await fetch(
          `/api/providers/client?${params.toString()}`,
        );
        if (!response.ok) throw new Error("Failed to fetch connections");

        const data = await response.json();
        const connectionList = data.connections || [];
        const nextPagination = getSafePagination(data.pagination, pageSize);
        const nextTotals = getSafeTotals(data.totals, connectionList.length);

        setConnections(connectionList);
        setProviderOptions(getProviderOptions(data.providerOptions));
        setPagination(nextPagination);
        setTotals(nextTotals);
        setPage(getPaginationPageValue(data.pagination, targetPage));
        return connectionList;
      } catch (error) {
        console.error("Error fetching connections:", error);
        setConnections([]);
        setProviderOptions([]);
        setPagination({ page: 1, pageSize, total: 0, totalPages: 1 });
        setTotals({ eligibleConnections: 0, providerFilteredConnections: 0 });
        return [];
      }
    },
    [accountFilter, expiringFirst, page, pageSize, providerFilter],
  );

  // Fetch quota for a specific connection. Background refreshes keep the card
  // mounted and only patch quota rows when fresh data arrives.
  const fetchQuota = useCallback(async (connectionId, provider, options = {}) => {
    const {
      showLoading = true,
      clearExistingError = true,
      preserveError = false,
    } = options;

    if (showLoading) {
      setLoading((prev) => ({ ...prev, [connectionId]: true }));
    }
    if (clearExistingError) {
      setErrors((prev) => ({ ...prev, [connectionId]: null }));
    }

    try {
      console.log(
        `[ProviderLimits] Fetching quota for ${provider} (${connectionId})`,
      );
      const response = await fetch(`/api/usage/${connectionId}`);

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        const errorMsg = errorData.error || response.statusText;

        // Handle different error types gracefully
        if (response.status === 404) {
          // Connection not found - skip silently
          console.warn(
            `[ProviderLimits] Connection not found for ${provider}, skipping`,
          );
          if (!preserveError) {
            setErrors((prev) => ({
              ...prev,
              [connectionId]: "Connection not found",
            }));
          }
          return;
        }

        if (response.status === 401) {
          // Auth error - show message instead of throwing
          console.warn(
            `[ProviderLimits] Auth error for ${provider}:`,
            errorMsg,
          );
          const quotaEntry = {
            quotas: [],
            message: errorMsg,
          };
          setQuotaData((prev) => ({
            ...prev,
            [connectionId]: quotaEntry,
          }));
          setErrors((prev) => ({ ...prev, [connectionId]: null }));
          setQuotaCache(connectionId, quotaEntry);
          return;
        }

        throw new Error(`HTTP ${response.status}: ${errorMsg}`);
      }

      const data = await response.json();
      console.log(`[ProviderLimits] Got quota for ${provider}:`, data);

      // Parse quota data using provider-specific parser
      const parsedQuotas = parseQuotaData(provider, data);

      const quotaEntry = {
        quotas: parsedQuotas,
        plan: data.plan || null,
        message: data.message || null,
        raw: data,
      };

      setQuotaData((prev) => ({
        ...prev,
        [connectionId]: quotaEntry,
      }));
      setErrors((prev) => ({ ...prev, [connectionId]: null }));
      setQuotaCache(connectionId, quotaEntry);
    } catch (error) {
      console.error(
        `[ProviderLimits] Error fetching quota for ${provider} (${connectionId}):`,
        error,
      );
      if (!preserveError) {
        setErrors((prev) => ({
          ...prev,
          [connectionId]: error.message || "Failed to fetch quota",
        }));
      }
    } finally {
      if (showLoading) {
        setLoading((prev) => ({ ...prev, [connectionId]: false }));
      }
    }
  }, []);

  // Refresh quota for a specific provider
  const refreshProvider = useCallback(
    async (connectionId, provider) => {
      setRefreshingQuotaIds((prev) => new Set(prev).add(connectionId));
      try {
        await fetchQuota(connectionId, provider, {
          showLoading: false,
          clearExistingError: false,
          preserveError: false,
        });
        setLastUpdated(new Date());
      } finally {
        setRefreshingQuotaIds((prev) => {
          const next = new Set(prev);
          next.delete(connectionId);
          return next;
        });
      }
    },
    [fetchQuota],
  );

  const handleResetCodexLimit = useCallback(
    async (connectionId, provider) => {
      if (provider !== "codex" || resettingLimitId) return;

      setResettingLimitId(connectionId);
      setErrors((prev) => ({ ...prev, [connectionId]: null }));

      try {
        const response = await fetch(`/api/usage/${connectionId}/codex-reset-credits`, { method: "POST" });
        const result = await response.json().catch(() => ({}));

        if (!response.ok) {
          throw new Error(result.message || result.error || result.code || "Failed to reset Codex limit");
        }

        await fetchQuota(connectionId, provider);
        setLastUpdated(new Date());
      } catch (error) {
        setErrors((prev) => ({ ...prev, [connectionId]: error.message || "Failed to reset Codex limit" }));
      } finally {
        setResettingLimitId(null);
      }
    },
    [fetchQuota, resettingLimitId],
  );

  const handleDeleteConnection = useCallback(
    async (id) => {
      if (!confirm("Delete this connection?")) return;
      setDeletingId(id);
      try {
        const res = await fetch(`/api/providers/${id}`, { method: "DELETE" });
        if (res.ok) {
          setQuotaData((prev) => {
            const next = { ...prev };
            delete next[id];
            return next;
          });
          setLoading((prev) => {
            const next = { ...prev };
            delete next[id];
            return next;
          });
          setErrors((prev) => {
            const next = { ...prev };
            delete next[id];
            return next;
          });

          if (typeof window !== "undefined") {
            try {
              const cache = getQuotaCache();
              if (cache[id]) {
                delete cache[id];
                window.localStorage.setItem(
                  QUOTA_CACHE_KEY,
                  JSON.stringify(cache),
                );
              }
            } catch (e) {
              console.error("Error deleting cache entry:", e);
            }
          }

          await reconcileConnectionsPage(fetchConnections, page);
        }
      } catch (error) {
        console.error("Error deleting connection:", error);
      } finally {
        setDeletingId(null);
      }
    },
    [fetchConnections, page],
  );

  const handleToggleConnectionActive = useCallback(
    async (id, isActive) => {
      setTogglingId(id);
      try {
        const res = await fetch(`/api/providers/${id}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ isActive }),
        });
        if (res.ok) {
          setQuotaData((prev) => {
            const next = { ...prev };
            return next;
          });
          await reconcileConnectionsPage(fetchConnections, page);
        }
      } catch (error) {
        console.error("Error updating connection status:", error);
      } finally {
        setTogglingId(null);
      }
    },
    [fetchConnections, page],
  );

  const handleUpdateConnection = useCallback(
    async (formData) => {
      if (!selectedConnection?.id) return;
      const connectionId = selectedConnection.id;
      const provider = selectedConnection.provider;
      try {
        const res = await fetch(`/api/providers/${connectionId}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(formData),
        });
        if (res.ok) {
          await fetchConnections();
          setShowEditModal(false);
          setSelectedConnection(null);
          if (USAGE_SUPPORTED_PROVIDERS.includes(provider)) {
            await fetchQuota(connectionId, provider);
          }
        }
      } catch (error) {
        console.error("Error saving connection:", error);
      }
    },
    [selectedConnection, fetchConnections, fetchQuota],
  );

  useEffect(() => {
    let cancelled = false;
    fetch("/api/proxy-pools?isActive=true", { cache: "no-store" })
      .then((res) => res.json())
      .then((data) => {
        if (!cancelled && data?.proxyPools) {
          setProxyPools(data.proxyPools);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const refreshAll = useCallback(async (force = false) => {
    if (refreshingAllRef.current) return;

    refreshingAllRef.current = true;
    setRefreshingAll(true);
    setCountdown(AUTO_REFRESH_SECONDS);

    // Throttle Claude: poll its quota every Nth auto-tick (manual force bypasses)
    const tick = (tickCountRef.current += 1);
    const claudeEvery = Math.round(CLAUDE_REFRESH_INTERVAL_MS / REFRESH_INTERVAL_MS);
    const shouldFetch = (conn) =>
      force || conn.provider !== "claude" || tick % claudeEvery === 0;

    try {
      const visibleConnections = connections;

      await Promise.all(
        visibleConnections
          .filter(shouldFetch)
          .map((conn) =>
            fetchQuota(conn.id, conn.provider, {
              showLoading: false,
              clearExistingError: false,
              preserveError: true,
            }),
          ),
      );

      setLastUpdated(new Date());
    } catch (error) {
      console.error("Error refreshing all providers:", error);
    } finally {
      refreshingAllRef.current = false;
      setRefreshingAll(false);
    }
  }, [connections, fetchQuota]);

  useEffect(() => {
    const initializeData = async () => {
      setConnectionsLoading(true);
      const visibleConnections = await fetchConnections(page);
      setConnectionsLoading(false);

      // Always fetch fresh quota on mount, no cache display
      setLoading(buildLoadingState(visibleConnections));
      setErrors((prev) =>
        filterQuotaStateByConnections(prev, visibleConnections),
      );
      setQuotaData((prev) =>
        filterQuotaStateByConnections(prev, visibleConnections),
      );

      await Promise.all(
        visibleConnections.map((conn) => fetchQuota(conn.id, conn.provider)),
      );
      setLastUpdated(new Date());
    };

    initializeData();
  }, [fetchConnections, fetchQuota, page]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const stored = window.localStorage.getItem(AUTO_REFRESH_STORAGE_KEY);
    setAutoRefresh(stored === null ? true : stored === "true");
    setHasHydratedAutoRefresh(true);
  }, []);

  // Persist auto-refresh preference
  useEffect(() => {
    if (typeof window === "undefined" || !hasHydratedAutoRefresh) return;
    window.localStorage.setItem(AUTO_REFRESH_STORAGE_KEY, String(autoRefresh));
  }, [autoRefresh, hasHydratedAutoRefresh]);

  // Load auto-ping per-connection maps
  useEffect(() => {
    fetch("/api/settings", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : {}))
      .then((s) => setAutoPingMaps({
        claude: s?.claudeAutoPing?.connections || {},
        codex: s?.codexAutoPing?.connections || {},
      }))
      .catch(() => {});
  }, []);

  const toggleAutoPing = useCallback(async (connectionId, provider, on) => {
    const settingsKey = AUTO_PING_SETTINGS_KEYS[provider];
    if (!settingsKey) return;

    const previous = autoPingMaps;
    const nextProviderMap = { ...(autoPingMaps[provider] || {}), [connectionId]: on };
    const nextMaps = { ...autoPingMaps, [provider]: nextProviderMap };
    setAutoPingMaps(nextMaps);
    try {
      const r = await fetch("/api/settings", { cache: "no-store" });
      const s = r.ok ? await r.json() : {};
      const cfg = { ...(s[settingsKey] || {}), connections: nextProviderMap };
      await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [settingsKey]: cfg }),
      });
    } catch {
      setAutoPingMaps(previous);
    }
  }, [autoPingMaps]);

  // Auto-refresh interval
  useEffect(() => {
    const stopTimers = () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
      if (countdownRef.current) {
        clearInterval(countdownRef.current);
        countdownRef.current = null;
      }
    };

    const startTimers = () => {
      if (intervalRef.current || countdownRef.current) return;
      setCountdown(AUTO_REFRESH_SECONDS);

      intervalRef.current = setInterval(() => {
        refreshAll();
      }, REFRESH_INTERVAL_MS);

      countdownRef.current = setInterval(() => {
        setCountdown((prev) => {
          if (prev <= 1) return AUTO_REFRESH_SECONDS;
          return prev - 1;
        });
      }, 1000);
    };

    if (!hasHydratedAutoRefresh || !autoRefresh || document.hidden) {
      stopTimers();
      return;
    }

    startTimers();

    return () => {
      stopTimers();
    };
  }, [autoRefresh, refreshAll, hasHydratedAutoRefresh]);

  // Pause auto-refresh when tab is hidden (Page Visibility API)
  useEffect(() => {
    const stopTimers = () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
      if (countdownRef.current) {
        clearInterval(countdownRef.current);
        countdownRef.current = null;
      }
    };

    const startTimers = () => {
      if (intervalRef.current || countdownRef.current) return;
      setCountdown(AUTO_REFRESH_SECONDS);
      intervalRef.current = setInterval(() => refreshAll(), REFRESH_INTERVAL_MS);
      countdownRef.current = setInterval(() => {
        setCountdown((prev) =>
          prev <= 1 ? AUTO_REFRESH_SECONDS : prev - 1,
        );
      }, 1000);
    };

    const handleVisibilityChange = () => {
      if (document.hidden) {
        stopTimers();
      } else if (autoRefresh && hasHydratedAutoRefresh) {
        startTimers();
      }
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      stopTimers();
    };
  }, [autoRefresh, refreshAll, hasHydratedAutoRefresh]);

  const sortedConnections = useMemo(
    () =>
      sortVisibleConnections(
        connections,
        quotaData,
        expiringFirst,
        providerFilter,
        quotaSortMode,
      ),
    [connections, quotaData, expiringFirst, providerFilter, quotaSortMode],
  );

  const providerGroups = useMemo(
    () =>
      buildProviderGroups(
        sortedConnections,
        quotaData,
        quotaSortMode,
        expiringFirst,
      ),
    [sortedConnections, quotaData, quotaSortMode, expiringFirst],
  );

  // Connection is depleted when any quota entry hit the threshold
  const isConnectionDepleted = (conn) => {
    const quotas = quotaData[conn.id]?.quotas;
    if (!quotas?.length) return false;
    return quotas.some((q) => {
      if (!q.total || q.total <= 0) return false;
      return calculatePercentage(q.used, q.total) <= DEPLETED_QUOTA_THRESHOLD;
    });
  };

  const bulkSetActive = useCallback(
    async (targetIds, isActive) => {
      if (!targetIds.length || bulkToggling) return;
      setBulkToggling(true);
      try {
        await Promise.all(
          targetIds.map((id) =>
            fetch(`/api/providers/${id}`, {
              method: "PUT",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ isActive }),
            }),
          ),
        );
        await reconcileConnectionsPage(fetchConnections, page);
      } catch (error) {
        console.error("Error bulk toggling connections:", error);
      } finally {
        setBulkToggling(false);
      }
    },
    [bulkToggling, fetchConnections, page],
  );

  const handleDisableDepleted = () => {
    const ids = sortedConnections
      .filter((c) => (c.isActive ?? true) && isConnectionDepleted(c))
      .map((c) => c.id);
    bulkSetActive(ids, false);
  };

  const handleEnableAvailable = () => {
    const ids = sortedConnections
      .filter((c) => !(c.isActive ?? true) && !isConnectionDepleted(c))
      .map((c) => c.id);
    bulkSetActive(ids, true);
  };

  const selectedProviderLabel =
    providerFilter === "all" ? "All providers" : providerFilter;
  const hasEligibleConnections = totals.eligibleConnections > 0;
  const hasVisibleConnections = sortedConnections.length > 0;
  const emptyState = getConnectionsEmptyMessage(
    totals,
    providerFilter,
    accountFilter,
  );
  const connectionsPageSummary = getConnectionsPaginationSummary(pagination);
  const isCustomPageSize = !ACCOUNT_PAGE_SIZE_OPTIONS.includes(pageSize);
  const pageSizeLabel = getPageSizeLabel(pageSize, isCustomPageSize);

  if (!connectionsLoading && !hasEligibleConnections) {
    return (
      <Card padding="lg">
        <div className="text-center py-12">
          <span className="material-symbols-outlined text-[64px] text-text-muted opacity-20">
            cloud_off
          </span>
          <h3 className="mt-4 text-lg font-semibold text-text-primary">
            No Providers Connected
          </h3>
          <p className="mt-2 text-sm text-text-muted max-w-md mx-auto">
            Connect to providers with OAuth to track your API quota limits and
            usage.
          </p>
        </div>
      </Card>
    );
  }

  if (!connectionsLoading && !hasVisibleConnections) {
    return (
      <Card padding="lg">
        <div className="text-center py-12">
          <span className="material-symbols-outlined text-[64px] text-text-muted opacity-20">
            {emptyState.icon}
          </span>
          <h3 className="mt-4 text-lg font-semibold text-text-primary">
            {emptyState.title}
          </h3>
          <p className="mt-2 text-sm text-text-muted max-w-md mx-auto">
            {emptyState.description}
          </p>
        </div>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header Controls */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-end">
        <div className="flex flex-wrap items-center gap-1.5">
          <div className="relative">
            <button
              type="button"
              onClick={() => setProviderMenuOpen((prev) => !prev)}
              className="flex h-8 items-center justify-between gap-1 rounded-lg border border-black/10 bg-black/[0.02] px-2 text-xs text-text-primary transition-colors hover:bg-black/5 dark:border-white/10 dark:bg-white/[0.03] dark:hover:bg-white/10"
              aria-haspopup="menu"
              aria-expanded={providerMenuOpen}
              title="Filter quota providers"
            >
              <span className="flex min-w-0 items-center gap-1.5">
                {providerFilter === "all" ? (
                  <span className="material-symbols-outlined text-[14px] text-text-muted">
                    apps
                  </span>
                ) : (
                  <ProviderIcon
                    src={`/providers/${providerFilter}.png`}
                    alt={providerFilter}
                    size={18}
                    className="size-[18px] rounded object-contain"
                    fallbackText={providerFilter.slice(0, 2).toUpperCase()}
                  />
                )}
                <span className="truncate capitalize hidden lg:inline">
                  {selectedProviderLabel}
                </span>
              </span>
              <span className="material-symbols-outlined text-[14px] text-text-muted">
                expand_more
              </span>
            </button>

            {providerMenuOpen && (
              <>
                <button
                  type="button"
                  className="fixed inset-0 z-30 bg-transparent"
                  aria-label="Close provider filter"
                  onClick={() => setProviderMenuOpen(false)}
                />
                <div className="absolute left-0 z-40 mt-2 w-64 overflow-hidden rounded-2xl border border-black/10 bg-surface/95 p-1.5 shadow-xl shadow-black/10 backdrop-blur dark:border-white/10 dark:bg-surface/95 sm:w-72">
                  <button
                    type="button"
                    onClick={() => {
                      if (shouldResetPage(providerFilter, "all")) {
                        setPage(1);
                      }
                      setProviderFilter("all");
                      setProviderMenuOpen(false);
                    }}
                    className={`flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm transition-colors ${providerFilter === "all" ? "bg-primary/10 text-primary" : "text-text-primary hover:bg-black/5 dark:hover:bg-white/10"}`}
                  >
                    <span className="material-symbols-outlined text-[22px]">
                      apps
                    </span>
                    <span className="font-medium">All providers</span>
                    {providerFilter === "all" && (
                      <span className="material-symbols-outlined ml-auto text-[20px]">
                        check
                      </span>
                    )}
                  </button>
                  <div className="my-1 h-px bg-black/10 dark:bg-white/10" />
                  <div className="max-h-72 overflow-y-auto pr-1">
                    {providerOptions.map((provider) => (
                      <button
                        key={provider}
                        type="button"
                        onClick={() => {
                          if (shouldResetPage(providerFilter, provider)) {
                            setPage(1);
                          }
                          setProviderFilter(provider);
                          setProviderMenuOpen(false);
                        }}
                        className={`flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm transition-colors ${providerFilter === provider ? "bg-primary/10 text-primary" : "text-text-primary hover:bg-black/5 dark:hover:bg-white/10"}`}
                      >
                        <ProviderIcon
                          src={`/providers/${provider}.png`}
                          alt={provider}
                          size={24}
                          className="size-6 rounded-md object-contain"
                          fallbackText={provider.slice(0, 2).toUpperCase()}
                        />
                        <span className="font-medium capitalize">
                          {provider}
                        </span>
                        {providerFilter === provider && (
                          <span className="material-symbols-outlined ml-auto text-[20px]">
                            check
                          </span>
                        )}
                      </button>
                    ))}
                  </div>
                </div>
              </>
            )}
          </div>
          <select
            value={accountFilter}
            onChange={(event) => {
              const nextValue = event.target.value;
              if (shouldResetPage(accountFilter, nextValue)) {
                setPage(1);
              }
              setAccountFilter(nextValue);
            }}
            className="h-8 rounded-lg border border-black/10 bg-black/[0.02] px-2 text-xs text-text-primary outline-none transition-colors hover:bg-black/5 dark:border-white/10 dark:bg-white/[0.03] dark:hover:bg-white/10"
            aria-label="Filter accounts by status"
          >
            {ACCOUNT_FILTER_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>

          <select
            value={quotaSortMode}
            onChange={(event) => setQuotaSortMode(event.target.value)}
            className="h-8 rounded-lg border border-black/10 bg-black/[0.02] px-2 text-xs text-text-primary outline-none transition-colors hover:bg-black/5 dark:border-white/10 dark:bg-white/[0.03] dark:hover:bg-white/10"
            aria-label="Sort accounts by quota remaining"
          >
            {QUOTA_SORT_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>

          <button
            type="button"
            onClick={() => setExpiringFirst((prev) => !prev)}
            aria-pressed={expiringFirst}
            className={`flex h-8 shrink-0 items-center gap-1 rounded-lg border px-2 text-xs transition-colors ${expiringFirst ? "border-amber-500/40 bg-amber-500/10 text-amber-500" : "border-black/10 text-text-primary hover:bg-black/5 dark:border-white/10 dark:hover:bg-white/5"}`}
            title="Sort accounts by earliest quota reset time"
          >
            <span className="material-symbols-outlined text-[14px]">
              hourglass_top
            </span>
            <span className="hidden sm:inline">Expiring first</span>
          </button>

          {/* Bulk: disable depleted */}
          <button
            type="button"
            onClick={handleDisableDepleted}
            disabled={bulkToggling}
            className="flex h-8 shrink-0 items-center gap-1 rounded-lg border border-red-500/30 px-2 text-xs text-red-500 transition-colors hover:bg-red-500/10 disabled:opacity-50"
            title="Disable connections with depleted quota on the current page"
          >
            <span className="material-symbols-outlined text-[14px]">block</span>
            <span className="hidden sm:inline">Turn off Empty</span>
          </button>

          {/* Bulk: enable available */}
          <button
            type="button"
            onClick={handleEnableAvailable}
            disabled={bulkToggling}
            className="flex h-8 shrink-0 items-center gap-1 rounded-lg border border-emerald-500/30 px-2 text-xs text-emerald-500 transition-colors hover:bg-emerald-500/10 disabled:opacity-50"
            title="Enable connections that still have quota on the current page"
          >
            <span className="material-symbols-outlined text-[14px]">
              check_circle
            </span>
            <span className="hidden sm:inline">Turn on Available</span>
          </button>

          {/* Auto-refresh toggle */}
          <button
            onClick={() => setAutoRefresh((prev) => !prev)}
            className="flex h-8 shrink-0 items-center gap-1 rounded-lg border border-black/10 px-2 text-xs transition-colors hover:bg-black/5 dark:border-white/10 dark:hover:bg-white/5"
            title={autoRefresh ? "Disable auto-refresh" : "Enable auto-refresh"}
          >
            <span
              className={`material-symbols-outlined text-[14px] ${
                autoRefresh ? "text-primary" : "text-text-muted"
              }`}
            >
              {autoRefresh ? "toggle_on" : "toggle_off"}
            </span>
            <span className="hidden text-text-primary sm:inline">
              Auto-refresh
            </span>
            {autoRefresh && (
              <span className="text-[10px] text-text-muted tabular-nums">
                ({countdown}s)
              </span>
            )}
          </button>


          {/* Refresh all button */}
          <button
            type="button"
            onClick={() => refreshAll(true)}
            disabled={refreshingAll}
            className="flex h-8 shrink-0 items-center gap-1 rounded-lg border border-black/10 px-2 text-xs text-text-primary transition-colors hover:bg-black/5 dark:border-white/10 dark:hover:bg-white/5 disabled:opacity-50"
            title="Refresh all"
          >
            <span
              className={`material-symbols-outlined text-[14px] ${refreshingAll ? "animate-spin" : ""}`}
            >
              refresh
            </span>
          </button>
        </div>
      </div>

      {/* Provider cards: 2 columns, compact */}
      {expiringFirst && (
        <div className="rounded-xl border border-amber-500/20 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
          Expiring-first currently reorders accounts inside the current page.
          Cross-page ordering still follows backend pagination.
        </div>
      )}

      <div className="space-y-4">
        {providerGroups.map((group) => {
          const providerColor = getProviderColor(group.provider);
          const groupTone = getQuotaTone(
            Number.isFinite(group.lowestRemaining)
              ? group.lowestRemaining
              : 100,
          );

          return (
            <section key={group.provider} className="space-y-2">
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-black/10 pb-1.5 dark:border-white/10">
                <div className="flex min-w-0 items-center gap-2">
                  <div
                    className="flex size-8 shrink-0 items-center justify-center rounded-lg"
                    style={{ backgroundColor: `${providerColor}16` }}
                  >
                    <ProviderIcon
                      src={`/providers/${group.provider}.png`}
                      alt={group.provider}
                      size={25}
                      className="object-contain"
                      fallbackText={group.provider.slice(0, 2).toUpperCase()}
                      fallbackColor={providerColor}
                    />
                  </div>
                  <div className="min-w-0">
                    <h2 className="truncate text-sm font-semibold capitalize leading-tight text-text-primary">
                      {group.provider}
                      <span className="ml-1.5 text-xs font-normal text-text-muted">
                        ({group.connections.length})
                      </span>
                    </h2>
                    <p className="text-[10px] leading-tight text-text-muted">
                      {group.activeCount} active · lowest first
                    </p>
                  </div>
                </div>
                <div className={`rounded-full border px-2 py-0.5 text-[11px] font-semibold ${groupTone.border} ${groupTone.soft} ${groupTone.text}`}>
                  Lowest {Number.isFinite(group.lowestRemaining) ? `${group.lowestRemaining}%` : "N/A"}
                </div>
              </div>

              <div className="grid grid-cols-1 items-start gap-2.5 xl:grid-cols-2">
                {group.connections.map((conn) => {
                  const quota = quotaData[conn.id];
                  const isLoading = loading[conn.id];
                  const isRefreshingQuota = refreshingQuotaIds.has(conn.id);
                  const error = errors[conn.id];
                  const quotaStats = getConnectionQuotaStats(conn, quotaData);
                  const accountTone = getQuotaTone(
                    Number.isFinite(quotaStats.remaining)
                      ? quotaStats.remaining
                      : 100,
                  );
                  const sortedQuotaRows = [...(quota?.quotas || [])].sort(
                    (a, b) =>
                      getRemainingPercentage(a) - getRemainingPercentage(b) ||
                      String(a.name || "").localeCompare(String(b.name || "")),
                  );
                  const isInactive = conn.isActive === false;
                  const isCodex = conn.provider === "codex";
                  const resetCreditCount = getCodexResetCreditCount(quota);
                  const isResettingLimit = resettingLimitId === conn.id;
                  const rowBusy = deletingId === conn.id || togglingId === conn.id || isResettingLimit;
                  const resetCountdown = Number.isFinite(quotaStats.earliestReset)
                    ? formatResetTime(new Date(quotaStats.earliestReset))
                    : "-";

                  return (
                    <Card
                      key={conn.id}
                      padding="none"
                      className={`relative min-w-0 overflow-hidden ${isInactive ? "opacity-60" : ""}`}
                    >
                      <div className={`absolute inset-y-0 left-0 w-0.5 ${accountTone.bg}`} />
                      <div className="border-b border-black/10 px-2.5 py-1.5 pl-3.5 dark:border-white/10">
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0">
                            <div className="flex flex-wrap items-center gap-1">
                              <h3 className="truncate text-xs font-semibold text-text-primary">
                                {getConnectionLabel(conn) || conn.displayName || conn.email || conn.provider}
                              </h3>
                              <span className={`rounded-full px-1.5 py-0.5 text-[9px] font-semibold leading-none ${accountTone.soft} ${accountTone.text}`}>
                                {Number.isFinite(quotaStats.remaining)
                                  ? `${quotaStats.remaining}%`
                                  : "Pending"}
                              </span>
                            </div>
                            <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[10px] leading-tight text-text-muted">
                              {getConnectionSecondaryLabel(conn) && (
                                <span className="max-w-[220px] truncate">
                                  {getConnectionSecondaryLabel(conn)}
                                </span>
                              )}
                              {resetCountdown !== "-" && (
                                <span className="inline-flex items-center gap-1">
                                  <span className="material-symbols-outlined text-[12px]">schedule</span>
                                  {resetCountdown}
                                </span>
                              )}
                              {isCodex && (
                                <span className="inline-flex items-center gap-1">
                                  <span className="material-symbols-outlined text-[12px]">restart_alt</span>
                                  {resetCreditCount}
                                </span>
                              )}
                            </div>
                            {conn.provider === "kiro" && (
                              <div className="mt-2 flex flex-wrap items-center gap-1">
                                <span className="rounded-full bg-brand-500/10 px-2 py-0.5 text-[10px] font-semibold text-brand-600 dark:text-brand-300">
                                  {kiroMethodLabel(conn)}
                                </span>
                                {kiroRegion(conn) && (
                                  <span className="rounded-full bg-blue-500/10 px-2 py-0.5 text-[10px] font-semibold text-blue-600 dark:text-blue-400">
                                    {kiroRegion(conn)}
                                  </span>
                                )}
                                {conn.providerSpecificData?.profileArn && (
                                  <button
                                    type="button"
                                    onClick={() => copy(conn.providerSpecificData.profileArn, conn.id)}
                                    title={conn.providerSpecificData.profileArn}
                                    className="inline-flex max-w-full items-center gap-1 rounded-full border border-border-subtle px-2 py-0.5 text-[10px] text-text-muted transition-colors hover:text-primary"
                                  >
                                    <span className="material-symbols-outlined text-[12px]">
                                      {copied === conn.id ? "check" : "content_copy"}
                                    </span>
                                    <code className="truncate font-mono">
                                      {conn.providerSpecificData.profileArn}
                                    </code>
                                  </button>
                                )}
                              </div>
                            )}
                          </div>

                          <div className="flex shrink-0 flex-wrap items-center justify-end gap-0.5">
                            {isCodex && resetCreditCount > 0 && (
                              <Tooltip text={`Use one Codex reset credit. Available: ${resetCreditCount}`}>
                                <button
                                  type="button"
                                  onClick={() => setResetConfirmState({ connection: conn, resetCreditCount })}
                                  disabled={isLoading || isRefreshingQuota || rowBusy}
                                  className="flex h-6 items-center gap-1 rounded-md border border-primary/30 px-1.5 text-[10px] text-primary transition-colors hover:bg-primary/10 disabled:opacity-50"
                                >
                                  <span className={`material-symbols-outlined text-[15px] ${isResettingLimit ? "animate-spin" : ""}`}>
                                    {isResettingLimit ? "progress_activity" : "bolt"}
                                  </span>
                                  <span className="hidden lg:inline">Reset</span>
                                </button>
                              </Tooltip>
                            )}
                            {AUTO_PING_SETTINGS_KEYS[conn.provider] && conn.authType === "oauth" && (
                              <Tooltip text={AUTO_PING_TOOLTIPS[conn.provider]}>
                                <button
                                  type="button"
                                  onClick={() => toggleAutoPing(conn.id, conn.provider, !(autoPingMaps[conn.provider]?.[conn.id] === true))}
                                  aria-label="Toggle auto-ping"
                                  className={`flex h-6 w-6 items-center justify-center rounded-md transition-colors hover:bg-black/5 dark:hover:bg-white/5 ${autoPingMaps[conn.provider]?.[conn.id] === true ? "text-primary" : "text-text-muted"}`}
                                >
                                  <span className="material-symbols-outlined text-[16px]">bolt</span>
                                </button>
                              </Tooltip>
                            )}
                            <Tooltip text="Refresh quota">
                              <button
                                type="button"
                                onClick={() => refreshProvider(conn.id, conn.provider)}
                                disabled={isLoading || isRefreshingQuota || rowBusy}
                                aria-label="Refresh quota"
                                className="flex h-6 w-6 items-center justify-center rounded-md hover:bg-black/5 dark:hover:bg-white/5 transition-colors disabled:opacity-50"
                              >
                                <span
                                  className={`material-symbols-outlined text-[16px] text-text-muted ${isLoading || isRefreshingQuota ? "animate-spin" : ""}`}
                                >
                                  refresh
                                </span>
                              </button>
                            </Tooltip>
                            <Tooltip text="Edit connection">
                              <button
                                type="button"
                                onClick={() => {
                                  setSelectedConnection(conn);
                                  setShowEditModal(true);
                                }}
                                disabled={rowBusy}
                                aria-label="Edit connection"
                                className="flex h-6 w-6 items-center justify-center rounded-md hover:bg-black/5 dark:hover:bg-white/5 text-text-muted hover:text-primary transition-colors disabled:opacity-50"
                              >
                                <span className="material-symbols-outlined text-[16px]">
                                  edit
                                </span>
                              </button>
                            </Tooltip>
                            <Tooltip text="Delete connection">
                              <button
                                type="button"
                                onClick={() => handleDeleteConnection(conn.id)}
                                disabled={rowBusy}
                                aria-label="Delete connection"
                                className="flex h-6 w-6 items-center justify-center rounded-md hover:bg-red-500/10 text-red-500 transition-colors disabled:opacity-50"
                              >
                                <span
                                  className={`material-symbols-outlined text-[16px] ${deletingId === conn.id ? "animate-pulse" : ""}`}
                                >
                                  delete
                                </span>
                              </button>
                            </Tooltip>
                            <div
                              className="inline-flex items-center pl-0.5"
                              title={
                                (conn.isActive ?? true)
                                  ? "Disable connection"
                                  : "Enable connection"
                              }
                            >
                              <Toggle
                                size="sm"
                                checked={conn.isActive ?? true}
                                disabled={rowBusy}
                                onChange={(nextActive) =>
                                  handleToggleConnectionActive(conn.id, nextActive)
                                }
                              />
                            </div>
                          </div>
                        </div>
                      </div>

                      <div className="px-2.5 py-1.5 pl-3.5">
                        {isLoading ? (
                          <div className="space-y-1">
                            <div className="h-6 rounded-md bg-black/5 animate-pulse dark:bg-white/5" />
                            <div className="h-6 rounded-md bg-black/5 animate-pulse dark:bg-white/5" />
                          </div>
                        ) : error ? (
                          <div className="rounded-md border border-red-500/20 bg-red-500/10 px-2 py-1.5 text-xs text-red-600 dark:text-red-400">
                            {error}
                          </div>
                        ) : quota?.message ? (
                          <div className="rounded-md border border-blue-500/20 bg-blue-500/10 px-2 py-1.5 text-xs text-blue-600 dark:text-blue-400">
                            {quota.message}
                          </div>
                        ) : sortedQuotaRows.length ? (
                          <div className="overflow-hidden rounded-md border border-black/5 bg-black/[0.012] dark:border-white/5 dark:bg-white/[0.02]">
                            {sortedQuotaRows.map((quotaRow, index) => (
                              <QuotaMetricRow
                                key={`${quotaRow.name}-${index}`}
                                quota={quotaRow}
                              />
                            ))}
                          </div>
                        ) : (
                          <div className="rounded-md border border-border-subtle px-2 py-3 text-center text-xs text-text-muted">
                            No quota data available
                          </div>
                        )}
                      </div>
                    </Card>
                  );
                })}
              </div>
            </section>
          );
        })}
      </div>

      <div className="rounded-xl border border-black/10 bg-black/[0.02] px-3 py-2 dark:border-white/10 dark:bg-white/[0.03]">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-xs text-text-muted">{connectionsPageSummary}</span>
            <div className="flex flex-wrap items-center gap-2">
              <select
                value={isCustomPageSize ? "custom" : String(pageSize)}
                onChange={(event) => {
                  const nextValue = event.target.value;
                  if (nextValue === "custom") return;
                  const nextPageSize = Number.parseInt(nextValue, 10);
                  if (Number.isFinite(nextPageSize)) {
                    setPage(1);
                    setPageSize(nextPageSize);
                    setCustomPageSizeInput(String(nextPageSize));
                  }
                }}
                className="h-8 rounded-lg border border-black/10 bg-black/[0.02] px-2 text-xs text-text-primary outline-none transition-colors hover:bg-black/5 dark:border-white/10 dark:bg-white/[0.03] dark:hover:bg-white/10"
                aria-label="Accounts per page"
              >
                {ACCOUNT_PAGE_SIZE_OPTIONS.map((option) => (
                  <option key={option} value={String(option)}>
                    {option} / page
                  </option>
                ))}
                <option value="custom">Custom</option>
              </select>
              <input
                type="number"
                min="1"
                max={String(ACCOUNT_PAGE_SIZE_MAX)}
                inputMode="numeric"
                value={customPageSizeInput}
                onChange={(event) => setCustomPageSizeInput(event.target.value)}
                onBlur={() => {
                  const parsedValue = Number.parseInt(customPageSizeInput, 10);
                  if (!Number.isFinite(parsedValue)) {
                    setCustomPageSizeInput(String(pageSize));
                    return;
                  }
                  const nextPageSize = Math.min(ACCOUNT_PAGE_SIZE_MAX, Math.max(1, parsedValue));
                  setPage(1);
                  setPageSize(nextPageSize);
                  setCustomPageSizeInput(String(nextPageSize));
                }}
                onKeyDown={(event) => {
                  if (event.key !== "Enter") return;
                  const parsedValue = Number.parseInt(customPageSizeInput, 10);
                  if (!Number.isFinite(parsedValue)) {
                    setCustomPageSizeInput(String(pageSize));
                    return;
                  }
                  const nextPageSize = Math.min(ACCOUNT_PAGE_SIZE_MAX, Math.max(1, parsedValue));
                  setPage(1);
                  setPageSize(nextPageSize);
                  setCustomPageSizeInput(String(nextPageSize));
                }}
                className="h-8 w-20 rounded-lg border border-black/10 bg-black/[0.02] px-2 text-xs text-text-primary outline-none transition-colors hover:bg-black/5 dark:border-white/10 dark:bg-white/[0.03] dark:hover:bg-white/10"
                aria-label="Custom accounts per page"
                placeholder="Custom"
              />
              <span className="text-xs text-text-muted">Page {pagination.page} / {pagination.totalPages}</span>
            </div>
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => setPage(1)}
                disabled={
                  pagination.page <= 1 || connectionsLoading || refreshingAll
                }
                className="flex h-8 items-center rounded-lg border border-black/10 px-3 text-xs text-text-primary transition-colors hover:bg-black/5 disabled:cursor-not-allowed disabled:opacity-40 dark:border-white/10 dark:hover:bg-white/5"
              >
                First Page
              </button>
              <button
                type="button"
                onClick={() =>
                  setPage((currentPage) => Math.max(1, currentPage - 1))
                }
                disabled={
                  pagination.page <= 1 || connectionsLoading || refreshingAll
                }
                className="flex h-8 w-8 items-center justify-center rounded-lg border border-black/10 text-text-primary transition-colors hover:bg-black/5 disabled:cursor-not-allowed disabled:opacity-40 dark:border-white/10 dark:hover:bg-white/5"
                aria-label="Previous accounts page"
              >
                <span className="material-symbols-outlined text-[16px]">
                  chevron_left
                </span>
              </button>
              <button
                type="button"
                onClick={() =>
                  setPage((currentPage) =>
                    Math.min(pagination.totalPages, currentPage + 1),
                  )
                }
                disabled={
                  pagination.page >= pagination.totalPages ||
                  connectionsLoading ||
                  refreshingAll
                }
                className="flex h-8 w-8 items-center justify-center rounded-lg border border-black/10 text-text-primary transition-colors hover:bg-black/5 disabled:cursor-not-allowed disabled:opacity-40 dark:border-white/10 dark:hover:bg-white/5"
                aria-label="Next accounts page"
              >
                <span className="material-symbols-outlined text-[16px]">
                  chevron_right
                </span>
              </button>
              <button
                type="button"
                onClick={() => setPage(pagination.totalPages)}
                disabled={
                  pagination.page >= pagination.totalPages ||
                  connectionsLoading ||
                  refreshingAll
                }
                className="flex h-8 items-center rounded-lg border border-black/10 px-3 text-xs text-text-primary transition-colors hover:bg-black/5 disabled:cursor-not-allowed disabled:opacity-40 dark:border-white/10 dark:hover:bg-white/5"
              >
                Last Page
              </button>
            </div>
          </div>
        </div>

      <ConfirmModal
        isOpen={Boolean(resetConfirmState)}
        onClose={() => {
          if (!resettingLimitId) setResetConfirmState(null);
        }}
        onConfirm={async () => {
          const connection = resetConfirmState?.connection;
          if (!connection) return;
          await handleResetCodexLimit(connection.id, connection.provider);
          setResetConfirmState(null);
        }}
        title="Reset Codex limit?"
        message={`Use 1 Codex reset credit for ${getConnectionLabel(resetConfirmState?.connection || {}) || "this account"}. This cannot be undone. Remaining credits: ${resetConfirmState?.resetCreditCount ?? 0}.`}
        confirmText="Reset limit"
        cancelText="Cancel"
        variant="danger"
        loading={Boolean(resettingLimitId)}
      />

      <EditConnectionModal
        isOpen={showEditModal}
        connection={selectedConnection}
        proxyPools={proxyPools}
        onSave={handleUpdateConnection}
        onClose={() => {
          setShowEditModal(false);
          setSelectedConnection(null);
        }}
      />
    </div>
  );
}
