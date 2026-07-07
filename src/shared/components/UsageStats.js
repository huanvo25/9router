"use client";

import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { FREE_PROVIDERS, AI_PROVIDERS } from "@/shared/constants/providers";

// Keep providers without serviceKinds (default LLM) or with "llm" in serviceKinds
function isLLMProvider(id) {
  const p = AI_PROVIDERS[id];
  if (!p?.serviceKinds) return true;
  return p.serviceKinds.includes("llm");
}
import Badge from "./Badge";
import Card from "./Card";
import OverviewCards from "@/app/(dashboard)/dashboard/usage/components/OverviewCards";
import UsageTable, { fmt, fmtTime } from "@/app/(dashboard)/dashboard/usage/components/UsageTable";
import UsageChart from "@/app/(dashboard)/dashboard/usage/components/UsageChart";

function timeAgo(timestamp) {
  if (!timestamp) return "Never";
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return "Never";
  const diff = Math.floor((Date.now() - date) / 1000);
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function formatRequestTime(timestamp) {
  if (!timestamp) return "-";
  const sourceDate = new Date(timestamp);
  if (Number.isNaN(sourceDate.getTime())) return "-";
  const date = new Date(sourceDate.getTime() + 7 * 60 * 60 * 1000);
  const pad = (value) => String(value).padStart(2, "0");
  return `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())} ${pad(date.getUTCDate())}/${pad(date.getUTCMonth() + 1)}/${date.getUTCFullYear()}`;
}

function formatErrorRate(rate) {
  const value = Number(rate || 0) * 100;
  if (!Number.isFinite(value)) return "0%";
  if (value > 0 && value < 0.1) return "<0.1%";
  return `${value.toFixed(value >= 10 ? 0 : 1)}%`;
}

// Auto-update time display every second without re-rendering parent
function TimeAgo({ timestamp }) {
  const [, setTick] = useState(0);
  
  useEffect(() => {
    const timer = setInterval(() => setTick(t => t + 1), 1000);
    return () => clearInterval(timer);
  }, []);
  
  return <>{timeAgo(timestamp)}</>;
}

function getProviderLabel(providerId, providerNameMap = {}, fallbackName = null) {
  if (!providerId) return "-";
  return fallbackName || providerNameMap[providerId] || AI_PROVIDERS[providerId]?.name || providerId;
}

const PROVIDER_HUES = [205, 158, 266, 36, 187, 82, 232, 318, 28, 174, 48, 286];

function hashProvider(provider = "") {
  let hash = 0;
  for (let i = 0; i < provider.length; i += 1) {
    hash = ((hash << 5) - hash) + provider.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash);
}

function getProviderHue(provider) {
  return PROVIDER_HUES[hashProvider(provider || "unknown") % PROVIDER_HUES.length];
}

function getProviderBadgeStyle(provider) {
  const hue = getProviderHue(provider);
  return { "--provider-hue": hue };
}

function getProviderDotStyle(provider) {
  return { "--provider-hue": getProviderHue(provider) };
}

function isOkStatus(status) {
  const value = String(status || "").trim().toLowerCase();
  return !value || value === "ok" || value === "success";
}

function getTokenNumber(value) {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function getRequestErrorInfo(request = {}) {
  const promptTokens = getTokenNumber(request.promptTokens);
  const completionTokens = getTokenNumber(request.completionTokens);
  const statusError = !isOkStatus(request.status);
  const inputZero = promptTokens <= 0;
  const outputZero = completionTokens <= 0;
  const reasons = [];

  if (statusError) reasons.push(`status:${request.status || "unknown"}`);
  if (inputZero) reasons.push("input=0");
  if (outputZero) reasons.push("output=0");

  return {
    isError: request.isError === true || statusError || inputZero || outputZero,
    inputZero,
    outputZero,
    reason: request.errorReason || reasons.join(", "),
  };
}

function getErrorLabel(errorInfo) {
  if (!errorInfo?.isError) return "OK";
  const labels = [];
  const reason = errorInfo.reason || "";
  if (reason.includes("status:")) labels.push("Lỗi trạng thái");
  if (errorInfo.inputZero || reason.includes("input=0")) labels.push("Input = 0");
  if (errorInfo.outputZero || reason.includes("output=0")) labels.push("Output = 0");
  return labels.length ? labels.join(" · ") : "Có lỗi";
}

function ProviderBadge({ provider, label, isError = false, title, maxWidthClass = "max-w-[190px]" }) {
  const text = label || provider || "-";
  const content = (
    <span className={`block truncate ${maxWidthClass}`} title={title || text}>
      {text}
    </span>
  );

  if (isError) {
    return (
      <Badge variant="error" size="sm" className="border border-red-500/20">
        {content}
      </Badge>
    );
  }

  return (
    <span
      className="provider-badge inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10px] font-semibold"
      style={getProviderBadgeStyle(provider || text)}
    >
      {content}
    </span>
  );
}

function ModelProviderUsage({ usage, providerNameMap = {} }) {
  const models = usage?.models || [];
  const topProviders = usage?.topProviders || [];
  if (!usage || (!models.length && !topProviders.length)) return null;

  return (
    <Card className="overflow-hidden" padding="sm">
      <div className="flex flex-col gap-3 border-b border-border px-1 py-2 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <span className="text-xs font-semibold uppercase tracking-wide text-text-muted">Model / Provider</span>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-text-muted">
            <span>{fmt(usage.totalModels || 0)} models</span>
            <span>{fmt(usage.totalProviders || 0)} providers</span>
            <span>{fmt(usage.totalRequests || 0)} requests</span>
            <span className={(usage.totalErrors || 0) > 0 ? "font-semibold text-red-600 dark:text-red-400" : ""}>
              {fmt(usage.totalErrors || 0)} lỗi ({formatErrorRate(usage.errorRate)})
            </span>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          {topProviders.slice(0, 8).map((provider) => {
            const label = getProviderLabel(provider.provider, providerNameMap, provider.providerName);
            return (
              <div key={provider.provider} className="flex items-center gap-1.5 rounded-md border border-border bg-bg-subtle px-2 py-1">
                <ProviderBadge provider={provider.provider} label={label} maxWidthClass="max-w-[140px]" />
                <span className="font-mono text-[11px] text-text-main">{fmt(provider.requests)}</span>
                {(provider.errorCount || 0) > 0 && (
                  <span className="font-mono text-[11px] font-semibold text-red-600 dark:text-red-400">
                    {fmt(provider.errorCount)} lỗi · {formatErrorRate(provider.errorRate)}
                  </span>
                )}
              </div>
            );
          })}
        </div>
      </div>

      <div className="max-h-[520px] overflow-auto custom-scrollbar">
        <table className="w-full min-w-[1260px] border-collapse text-xs">
          <thead className="sticky top-0 z-10 bg-bg">
            <tr className="border-b border-border">
              <th className="py-2 pr-4 text-left font-semibold text-text-muted">Model</th>
              <th className="py-2 pr-4 text-right font-semibold text-text-muted">Requests</th>
              <th className="py-2 pr-4 text-left font-semibold text-text-muted">Provider</th>
              <th className="py-2 pr-4 text-right font-semibold text-text-muted">In / Out</th>
              <th className="py-2 pr-4 text-right font-semibold text-text-muted">Lỗi</th>
              <th className="py-2 pr-4 text-right font-semibold text-text-muted">% lỗi</th>
              <th className="py-2 text-right font-semibold text-text-muted">Lần cuối</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border/50">
            {models.map((model) => (
              <tr key={model.providerModelKey || `${model.provider || "unknown"}:${model.model}`} className={(model.errorCount || 0) > 0 ? "bg-red-500/[0.025] hover:bg-red-500/[0.06]" : "hover:bg-bg-subtle"}>
                <td className="max-w-[360px] py-2 pr-4 font-mono leading-snug text-text-main break-all" title={model.model}>
                  {model.model}
                </td>
                <td className="py-2 pr-4 text-right font-mono text-text-main">{fmt(model.totalRequests || 0)}</td>
                <td className="py-2 pr-4">
                  <div className="flex max-w-[520px] flex-wrap gap-1.5">
                    {(model.providers || []).slice(0, 8).map((provider) => {
                      const label = getProviderLabel(provider.provider, providerNameMap, provider.providerName || model.providerName);
                      const chipLabel = `${label} ${fmt(provider.requests || 0)}`;
                      const title = `${label}: ${fmt(provider.requests || 0)} requests · ${fmt(provider.totalTokens || 0)} tokens · ${fmt(provider.errorCount || 0)} lỗi · ${formatErrorRate(provider.errorRate)}`;
                      return (
                        <ProviderBadge
                          key={provider.provider}
                          provider={provider.provider}
                          label={chipLabel}
                          isError={(provider.errorCount || 0) > 0}
                          title={title}
                          maxWidthClass="max-w-[170px]"
                        />
                      );
                    })}
                  </div>
                </td>
                <td className="py-2 pr-4 text-right whitespace-nowrap">
                  <span className="text-primary">{fmt(model.promptTokens || 0)}↑</span>{" "}
                  <span className="text-success">{fmt(model.completionTokens || 0)}↓</span>
                </td>
                <td className="py-2 pr-4 text-right whitespace-nowrap">
                  {(model.errorCount || 0) > 0 ? (
                    <span className="font-mono font-semibold text-red-600 dark:text-red-400">
                      {fmt(model.errorCount || 0)}
                      <span className="ml-1 text-[10px] font-medium text-text-muted">
                        zero {fmt(model.zeroTokenCount || 0)}
                      </span>
                    </span>
                  ) : (
                    <span className="text-text-muted">OK</span>
                  )}
                </td>
                <td className="py-2 pr-4 text-right whitespace-nowrap">
                  <span
                    className={(model.errorCount || 0) > 0 ? "font-mono font-semibold text-red-600 dark:text-red-400" : "font-mono text-text-muted"}
                    title={`${fmt(model.errorCount || 0)} lỗi / ${fmt(model.totalRequests || 0)} requests`}
                  >
                    {formatErrorRate(model.errorRate)}
                  </span>
                </td>
                <td className="py-2 text-right text-text-muted whitespace-nowrap" title={formatRequestTime(model.lastUsed)}>
                  <TimeAgo timestamp={model.lastUsed} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function RecentRequests({ requests = [], providerNameMap = {} }) {
  return (
    <Card
      className="flex min-w-0 flex-col overflow-hidden"
      padding="sm"
      style={{ height: "min(78vh, 820px)", minHeight: 620 }}
    >
      {/* Header */}
      <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border px-1 py-2">
        <span className="text-xs font-semibold uppercase tracking-wide text-text-muted">Recent Requests</span>
        <span className="font-mono text-xs text-text-muted">{requests.length}</span>
      </div>

      {!requests.length ? (
        <div className="flex-1 flex items-center justify-center text-text-muted text-sm">No requests yet.</div>
      ) : (
        <div className="flex-1 overflow-auto custom-scrollbar">
          <table className="w-full min-w-[1220px] border-collapse text-xs">
            <thead className="sticky top-0 bg-bg z-10">
              <tr className="border-b border-border">
                <th className="py-1.5 text-left font-semibold text-text-muted w-2"></th>
                <th className="py-1.5 pr-3 text-left font-semibold text-text-muted">Model</th>
                <th className="py-1.5 pr-3 text-left font-semibold text-text-muted">Providers</th>
                <th className="py-1.5 text-right font-semibold text-text-muted whitespace-nowrap">In / Out</th>
                <th className="py-1.5 pr-3 text-left font-semibold text-text-muted">Lỗi</th>
                <th className="py-1.5 pr-3 text-right font-semibold text-text-muted whitespace-nowrap">Thời gian UTC+7</th>
                <th className="py-1.5 text-right font-semibold text-text-muted">Ago</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/50">
              {requests.map((r, i) => {
                const errorInfo = getRequestErrorInfo(r);
                const providerLabel = getProviderLabel(r.provider, providerNameMap, r.providerName);
                return (
                  <tr
                    key={i}
                    className={`transition-colors ${errorInfo.isError ? "bg-red-500/[0.03] hover:bg-red-500/[0.07]" : "hover:bg-bg-subtle"}`}
                    title={errorInfo.reason || undefined}
                  >
                    <td className="py-1.5">
                      <span
                        className={`block h-1.5 w-1.5 rounded-full ${errorInfo.isError ? "bg-error" : "provider-dot"}`}
                        style={errorInfo.isError ? undefined : getProviderDotStyle(r.provider)}
                      />
                    </td>
                    <td className="max-w-[360px] py-2 pr-3 font-mono leading-snug text-text-main break-all" title={r.model}>
                      {r.model || "-"}
                    </td>
                    <td className="max-w-[220px] py-2 pr-3">
                      <ProviderBadge
                        provider={r.provider}
                        label={providerLabel}
                        isError={errorInfo.isError}
                        title={errorInfo.reason ? `${providerLabel} · ${errorInfo.reason}` : providerLabel}
                      />
                    </td>
                    <td className="py-1.5 text-right whitespace-nowrap">
                      <span className={errorInfo.inputZero ? "font-semibold text-red-600 dark:text-red-400" : "text-primary"}>{fmt(r.promptTokens)}↑</span>
                      {" "}
                      <span className={errorInfo.outputZero ? "font-semibold text-red-600 dark:text-red-400" : "text-success"}>{fmt(r.completionTokens)}↓</span>
                    </td>
                    <td className="py-1.5 pr-3">
                      <span className={`inline-flex max-w-[220px] items-center rounded-md px-2 py-0.5 text-[11px] font-semibold ${
                        errorInfo.isError
                          ? "bg-red-500/10 text-red-600 dark:text-red-400"
                          : "bg-green-500/10 text-green-600 dark:text-green-400"
                      }`} title={errorInfo.reason || "OK"}>
                        <span className="truncate">{getErrorLabel(errorInfo)}</span>
                      </span>
                    </td>
                    <td className="py-1.5 pr-3 text-right font-mono text-text-main whitespace-nowrap" title={r.timestamp}>
                      {formatRequestTime(r.timestamp)}
                    </td>
                    <td className="py-1.5 text-right text-text-muted whitespace-nowrap"><TimeAgo timestamp={r.timestamp} /></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

function sortData(dataMap, pendingMap = {}, sortBy, sortOrder) {
  return Object.entries(dataMap || {})
    .map(([key, data]) => {
      const totalTokens = (data.promptTokens || 0) + (data.completionTokens || 0);
      const totalCost = data.cost || 0;
      const inputCost = totalTokens > 0 ? (data.promptTokens || 0) * (totalCost / totalTokens) : 0;
      const outputCost = totalTokens > 0 ? (data.completionTokens || 0) * (totalCost / totalTokens) : 0;
      return { ...data, key, totalTokens, totalCost, inputCost, outputCost, pending: pendingMap[key] || 0 };
    })
    .sort((a, b) => {
      let valA = a[sortBy];
      let valB = b[sortBy];
      if (typeof valA === "string") valA = valA.toLowerCase();
      if (typeof valB === "string") valB = valB.toLowerCase();
      if (valA < valB) return sortOrder === "asc" ? -1 : 1;
      if (valA > valB) return sortOrder === "asc" ? 1 : -1;
      return 0;
    });
}

function getGroupKey(item, keyField) {
  switch (keyField) {
    case "rawModel": return item.rawModel || "Unknown Model";
    case "accountName": return item.accountName || `Account ${item.connectionId?.slice(0, 8)}...` || "Unknown Account";
    case "keyName": return item.keyName || "Unknown Key";
    case "endpoint": return item.endpoint || "Unknown Endpoint";
    default: return item[keyField] || "Unknown";
  }
}

function groupDataByKey(data, keyField) {
  if (!Array.isArray(data)) return [];
  const groups = {};
  data.forEach((item) => {
    const gk = getGroupKey(item, keyField);
    if (!groups[gk]) {
      groups[gk] = {
        groupKey: gk,
        summary: { requests: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, cost: 0, inputCost: 0, outputCost: 0, lastUsed: null, pending: 0 },
        items: [],
      };
    }
    const s = groups[gk].summary;
    s.requests += item.requests || 0;
    s.promptTokens += item.promptTokens || 0;
    s.completionTokens += item.completionTokens || 0;
    s.totalTokens += item.totalTokens || 0;
    s.cost += item.cost || 0;
    s.inputCost += item.inputCost || 0;
    s.outputCost += item.outputCost || 0;
    s.pending += item.pending || 0;
    if (item.lastUsed && (!s.lastUsed || new Date(item.lastUsed) > new Date(s.lastUsed))) {
      s.lastUsed = item.lastUsed;
    }
    groups[gk].items.push(item);
  });
  return Object.values(groups);
}

const MODEL_COLUMNS = [
  { field: "rawModel", label: "Model" },
  { field: "provider", label: "Provider" },
  { field: "requests", label: "Requests", align: "right" },
  { field: "lastUsed", label: "Last Used", align: "right" },
];

const ACCOUNT_COLUMNS = [
  { field: "rawModel", label: "Model" },
  { field: "provider", label: "Provider" },
  { field: "accountName", label: "Account" },
  { field: "requests", label: "Requests", align: "right" },
  { field: "lastUsed", label: "Last Used", align: "right" },
];

const API_KEY_COLUMNS = [
  { field: "keyName", label: "API Key Name" },
  { field: "rawModel", label: "Model" },
  { field: "provider", label: "Provider" },
  { field: "requests", label: "Requests", align: "right" },
  { field: "lastUsed", label: "Last Used", align: "right" },
];

const ENDPOINT_COLUMNS = [
  { field: "endpoint", label: "Endpoint" },
  { field: "rawModel", label: "Model" },
  { field: "provider", label: "Provider" },
  { field: "requests", label: "Requests", align: "right" },
  { field: "lastUsed", label: "Last Used", align: "right" },
];

const TABLE_OPTIONS = [
  { value: "model", label: "Usage by Model" },
  { value: "account", label: "Usage by Account" },
  { value: "apiKey", label: "Usage by API Key" },
  { value: "endpoint", label: "Usage by Endpoint" },
];

const PERIODS = [
  { value: "today", label: "Today" },
  { value: "24h", label: "24h" },
  { value: "7d", label: "7D" },
  { value: "30d", label: "30D" },
  { value: "60d", label: "60D" },
  { value: "1y", label: "1Y" },
  { value: "all", label: "All" },
];

export default function UsageStats({ period: periodProp, setPeriod: setPeriodProp, hidePeriodSelector = false } = {}) {
  const router = useRouter();
  const searchParams = useSearchParams();

  const sortBy = searchParams.get("sortBy") || "rawModel";
  const sortOrder = searchParams.get("sortOrder") || "asc";

  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);
  const [fetching, setFetching] = useState(false);
  const [tableView, setTableView] = useState("model");
  const [viewMode, setViewMode] = useState("costs");
  const [providers, setProviders] = useState([]);
  const [periodLocal, setPeriodLocal] = useState("today");
  const isInitialLoad = useRef(true);
  const hasLoadedStats = useRef(false);
  const period = periodProp ?? periodLocal;
  const setPeriod = setPeriodProp ?? setPeriodLocal;

  // Fetch connected providers once, deduplicate by provider type
  // Always include noAuth free providers (e.g. opencode) regardless of connections
  useEffect(() => {
    Promise.all([
      fetch("/api/providers").then((r) => r.ok ? r.json() : null),
      fetch("/api/provider-nodes").then((r) => r.ok ? r.json() : null),
    ])
      .then(([d, nodesData]) => {
        // Build node name lookup for custom providers
        const nodeNameMap = {};
        for (const node of (nodesData?.nodes || [])) {
          nodeNameMap[node.id] = node.name;
        }
        const seen = new Set();
        const unique = (d?.connections || []).filter((c) => {
          if (c.isActive === false) return false;
          if (!isLLMProvider(c.provider)) return false;
          if (seen.has(c.provider)) return false;
          seen.add(c.provider);
          return true;
        }).map((c) => ({
          ...c,
          nodeName: nodeNameMap[c.provider] || null,
        }));
        const noAuthProviders = Object.values(FREE_PROVIDERS)
          .filter((p) => p.noAuth && !seen.has(p.id) && isLLMProvider(p.id))
          .map((p) => ({ provider: p.id, name: p.name }));
        setProviders([...unique, ...noAuthProviders]);
      })
      .catch(() => {});
  }, []);

  // Fetch filtered stats via REST when period changes
  useEffect(() => {
    // First load: show full spinner; subsequent: show subtle fetching indicator
    if (isInitialLoad.current) {
      isInitialLoad.current = false;
      setLoading(true);
    } else {
      setFetching(true);
    }

    fetch(`/api/usage/stats?period=${period}`)
      .then((r) => r.ok ? r.json() : null)
      .then((data) => {
        if (data) {
          hasLoadedStats.current = true;
          setStats((prev) => ({ ...prev, ...data }));
        }
      })
      .catch(() => {})
      .finally(() => {
        setLoading(false);
        setFetching(false);
      });
  }, [period]);

  // SSE connection - real-time updates for activeRequests, recentRequests, and model/provider usage.
  useEffect(() => {
    const es = new EventSource(`/api/usage/stream?period=${encodeURIComponent(period)}`);

    es.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data);
        setStats((prev) => {
          if (!prev) return prev;
          return {
            ...prev,
            activeRequests: data.activeRequests,
            recentRequests: data.recentRequests,
            errorProvider: data.errorProvider,
            pending: data.pending,
            ...(data.modelProviderUsage ? { modelProviderUsage: data.modelProviderUsage } : {}),
            ...(data.errorCounts ? { errorCounts: data.errorCounts } : {}),
          };
        });
        if (hasLoadedStats.current) setLoading(false);
      } catch (err) {
        console.error("[SSE CLIENT] parse error:", err);
      }
    };

    es.onerror = () => setLoading(false);

    return () => es.close();
  }, [period]);

  const toggleSort = useCallback((tableType, field) => {
    const params = new URLSearchParams(searchParams.toString());
    if (params.get("sortBy") === field) {
      params.set("sortOrder", params.get("sortOrder") === "asc" ? "desc" : "asc");
    } else {
      params.set("sortBy", field);
      params.set("sortOrder", "asc");
    }
    router.replace(`?${params.toString()}`, { scroll: false });
  }, [searchParams, router]);

  // Compute active table data
  const activeTableConfig = useMemo(() => {
    if (!stats) return null;
    switch (tableView) {
      case "model": {
        const pendingMap = stats.pending?.byModel || {};
        return {
          columns: MODEL_COLUMNS,
          groupedData: groupDataByKey(sortData(stats.byModel, pendingMap, sortBy, sortOrder), "rawModel"),
          storageKey: "usage-stats:expanded-models",
          emptyMessage: "No usage recorded yet.",
          renderSummaryCells: (group) => (
            <>
              <td className="px-6 py-3 text-text-muted">—</td>
              <td className="px-6 py-3 text-right">{fmt(group.summary.requests)}</td>
              <td className="px-6 py-3 text-right text-text-muted whitespace-nowrap">{fmtTime(group.summary.lastUsed)}</td>
            </>
          ),
          renderDetailCells: (item) => (
            <>
              <td className={`px-6 py-3 font-medium transition-colors ${item.pending > 0 ? "text-primary" : ""}`}>{item.rawModel}</td>
              <td className="px-6 py-3">
                {item.pending > 0 ? (
                  <Badge variant="primary" size="sm">{item.provider}</Badge>
                ) : (
                  <ProviderBadge provider={item.provider} label={item.provider} maxWidthClass="max-w-[220px]" />
                )}
              </td>
              <td className="px-6 py-3 text-right">{fmt(item.requests)}</td>
              <td className="px-6 py-3 text-right text-text-muted whitespace-nowrap">{fmtTime(item.lastUsed)}</td>
            </>
          ),
        };
      }
      case "account": {
        const pendingMap = {};
        if (stats?.pending?.byAccount) {
          Object.entries(stats.byAccount || {}).forEach(([accountKey, data]) => {
            const connPending = stats.pending.byAccount[data.connectionId];
            if (connPending) {
              const modelKey = data.provider ? `${data.rawModel} (${data.provider})` : data.rawModel;
              pendingMap[accountKey] = connPending[modelKey] || 0;
            }
          });
        }
        return {
          columns: ACCOUNT_COLUMNS,
          groupedData: groupDataByKey(sortData(stats.byAccount, pendingMap, sortBy, sortOrder), "accountName"),
          storageKey: "usage-stats:expanded-accounts",
          emptyMessage: "No account-specific usage recorded yet.",
          renderSummaryCells: (group) => (
            <>
              <td className="px-6 py-3 text-text-muted">—</td>
              <td className="px-6 py-3 text-text-muted">—</td>
              <td className="px-6 py-3 text-right">{fmt(group.summary.requests)}</td>
              <td className="px-6 py-3 text-right text-text-muted whitespace-nowrap">{fmtTime(group.summary.lastUsed)}</td>
            </>
          ),
          renderDetailCells: (item) => (
            <>
              <td className={`px-6 py-3 font-medium transition-colors ${item.pending > 0 ? "text-primary" : ""}`}>{item.accountName || `Account ${item.connectionId?.slice(0, 8)}...`}</td>
              <td className={`px-6 py-3 font-medium transition-colors ${item.pending > 0 ? "text-primary" : ""}`}>{item.rawModel}</td>
              <td className="px-6 py-3">
                {item.pending > 0 ? (
                  <Badge variant="primary" size="sm">{item.provider}</Badge>
                ) : (
                  <ProviderBadge provider={item.provider} label={item.provider} maxWidthClass="max-w-[220px]" />
                )}
              </td>
              <td className="px-6 py-3 text-right">{fmt(item.requests)}</td>
              <td className="px-6 py-3 text-right text-text-muted whitespace-nowrap">{fmtTime(item.lastUsed)}</td>
            </>
          ),
        };
      }
      case "apiKey": {
        return {
          columns: API_KEY_COLUMNS,
          groupedData: groupDataByKey(sortData(stats.byApiKey, {}, sortBy, sortOrder), "keyName"),
          storageKey: "usage-stats:expanded-apikeys",
          emptyMessage: "No API key usage recorded yet.",
          renderSummaryCells: (group) => (
            <>
              <td className="px-6 py-3 text-text-muted">—</td>
              <td className="px-6 py-3 text-text-muted">—</td>
              <td className="px-6 py-3 text-right">{fmt(group.summary.requests)}</td>
              <td className="px-6 py-3 text-right text-text-muted whitespace-nowrap">{fmtTime(group.summary.lastUsed)}</td>
            </>
          ),
          renderDetailCells: (item) => (
            <>
              <td className="px-6 py-3 font-medium">{item.keyName}</td>
              <td className="px-6 py-3">{item.rawModel}</td>
              <td className="px-6 py-3"><ProviderBadge provider={item.provider} label={item.provider} maxWidthClass="max-w-[220px]" /></td>
              <td className="px-6 py-3 text-right">{fmt(item.requests)}</td>
              <td className="px-6 py-3 text-right text-text-muted whitespace-nowrap">{fmtTime(item.lastUsed)}</td>
            </>
          ),
        };
      }
      case "endpoint":
      default: {
        return {
          columns: ENDPOINT_COLUMNS,
          groupedData: groupDataByKey(sortData(stats.byEndpoint, {}, sortBy, sortOrder), "endpoint"),
          storageKey: "usage-stats:expanded-endpoints",
          emptyMessage: "No endpoint usage recorded yet.",
          renderSummaryCells: (group) => (
            <>
              <td className="px-6 py-3 text-text-muted">—</td>
              <td className="px-6 py-3 text-text-muted">—</td>
              <td className="px-6 py-3 text-right">{fmt(group.summary.requests)}</td>
              <td className="px-6 py-3 text-right text-text-muted whitespace-nowrap">{fmtTime(group.summary.lastUsed)}</td>
            </>
          ),
          renderDetailCells: (item) => (
            <>
              <td className="px-6 py-3 font-medium font-mono text-sm">{item.endpoint}</td>
              <td className="px-6 py-3">{item.rawModel}</td>
              <td className="px-6 py-3"><ProviderBadge provider={item.provider} label={item.provider} maxWidthClass="max-w-[220px]" /></td>
              <td className="px-6 py-3 text-right">{fmt(item.requests)}</td>
              <td className="px-6 py-3 text-right text-text-muted whitespace-nowrap">{fmtTime(item.lastUsed)}</td>
            </>
          ),
        };
      }
    }
  }, [stats, tableView, sortBy, sortOrder]);

  const providerNameMap = useMemo(() => {
    const map = {};
    for (const provider of providers) {
      const providerId = provider.provider || provider.id;
      if (!providerId) continue;
      map[providerId] = provider.nodeName || AI_PROVIDERS[providerId]?.name || provider.name || providerId;
    }
    return map;
  }, [providers]);

  if (!stats && !loading) return <div className="text-text-muted">Failed to load usage statistics.</div>;

  const spinner = (
    <div className="flex items-center justify-center py-12 text-text-muted">
      <span className="material-symbols-outlined text-[32px] animate-spin">progress_activity</span>
    </div>
  );

  return (
    <div className="flex min-w-0 flex-col gap-6">
      {/* Period selector (hidden when controlled by parent) */}
      {!hidePeriodSelector && (
        <div className="flex w-full items-center gap-2 sm:w-auto sm:self-end">
          <div className="grid flex-1 grid-cols-4 items-center gap-1 rounded-lg border border-border bg-bg-subtle p-1 sm:flex sm:flex-none">
            {PERIODS.map((p) => (
              <button
                key={p.value}
                onClick={() => setPeriod(p.value)}
                disabled={fetching}
                className={`rounded-md px-3 py-1 text-sm font-medium transition-colors ${period === p.value ? "bg-primary text-white shadow-sm" : "text-text-muted hover:bg-bg-hover hover:text-text"}`}
              >
                {p.label}
              </button>
            ))}
          </div>
          {fetching && (
            <span className="material-symbols-outlined text-[16px] text-text-muted animate-spin">progress_activity</span>
          )}
        </div>
      )}

      {/* Overview cards */}
      {loading ? spinner : <OverviewCards stats={stats} />}

      {/* Model / provider usage */}
      {loading ? spinner : <ModelProviderUsage usage={stats.modelProviderUsage} providerNameMap={providerNameMap} />}

      {/* Recent Requests */}
      {loading ? spinner : <RecentRequests requests={stats.recentRequests || []} providerNameMap={providerNameMap} />}

      {/* Token / Cost chart - sync period */}
      {loading ? spinner : <UsageChart period={period} />}

      {/* Table with dropdown selector */}
      <div className="flex flex-col gap-3">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <select
            value={tableView}
            onChange={(e) => setTableView(e.target.value)}
            className="w-full rounded-lg border border-border bg-surface px-3 py-1.5 text-sm font-medium text-text-main focus:outline-none focus:ring-2 focus:ring-primary/50 sm:w-auto"
            style={{ colorScheme: 'auto' }}
          >
            {TABLE_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
          <div className="grid grid-cols-2 items-center gap-1 rounded-lg border border-border bg-bg-subtle p-1 sm:flex">
            <button
              onClick={() => setViewMode("costs")}
              className={`px-3 py-1 rounded-md text-sm font-medium transition-colors ${viewMode === "costs" ? "bg-primary text-white shadow-sm" : "text-text-muted hover:text-text hover:bg-bg-hover"}`}
            >
              Costs
            </button>
            <button
              onClick={() => setViewMode("tokens")}
              className={`px-3 py-1 rounded-md text-sm font-medium transition-colors ${viewMode === "tokens" ? "bg-primary text-white shadow-sm" : "text-text-muted hover:text-text hover:bg-bg-hover"}`}
            >
              Tokens
            </button>
          </div>
        </div>
        {loading ? spinner : activeTableConfig && (
          <UsageTable
            title=""
            columns={activeTableConfig.columns}
            groupedData={activeTableConfig.groupedData}
            tableType={tableView}
            sortBy={sortBy}
            sortOrder={sortOrder}
            onToggleSort={toggleSort}
            viewMode={viewMode}
            storageKey={activeTableConfig.storageKey}
            renderSummaryCells={activeTableConfig.renderSummaryCells}
            renderDetailCells={activeTableConfig.renderDetailCells}
            emptyMessage={activeTableConfig.emptyMessage}
          />
        )}
      </div>
    </div>
  );
}
