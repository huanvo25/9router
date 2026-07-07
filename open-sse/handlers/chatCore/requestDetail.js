import { saveRequestUsage, appendRequestLog, saveRequestDetail } from "@/lib/usageDb.js";
import { normalizeUsageTokenObject, normalizeUsageTokens } from "@/shared/utils/usageTokens";
import { COLORS } from "../../utils/stream.js";

const OPTIONAL_PARAMS = [
  "temperature", "top_p", "top_k",
  "max_tokens", "max_completion_tokens",
  "thinking", "reasoning", "enable_thinking",
  "presence_penalty", "frequency_penalty",
  "seed", "stop", "tools", "tool_choice",
  "response_format", "prediction", "store", "metadata",
  "n", "logprobs", "top_logprobs", "logit_bias",
  "user", "parallel_tool_calls"
];

export function extractRequestConfig(body, stream) {
  const config = { messages: body.messages || [], model: body.model, stream };
  for (const param of OPTIONAL_PARAMS) {
    if (body[param] !== undefined) config[param] = body[param];
  }
  return config;
}

export function extractUsageFromResponse(responseBody) {
  if (!responseBody || typeof responseBody !== "object") return null;

  const hasKnownUsageFields = (usage) => usage && typeof usage === "object" && [
    "prompt_tokens", "completion_tokens", "input_tokens", "output_tokens",
    "promptTokens", "completionTokens", "inputTokens", "outputTokens",
    "promptTokenCount", "candidatesTokenCount", "prompt_eval_count", "eval_count",
    "total_tokens", "totalTokens", "totalTokenCount"
  ].some((key) => Object.prototype.hasOwnProperty.call(usage, key));

  if (hasKnownUsageFields(responseBody.usage)) {
    return normalizeUsageTokenObject(responseBody.usage);
  }

  if (responseBody.usageMetadata) {
    return normalizeUsageTokenObject({ usageMetadata: responseBody.usageMetadata });
  }

  return null;
}

export function buildRequestDetail(base, overrides = {}) {
  return {
    provider: base.provider || "unknown",
    model: base.model || "unknown",
    connectionId: base.connectionId || undefined,
    timestamp: new Date().toISOString(),
    latency: base.latency || { ttft: 0, total: 0 },
    tokens: normalizeUsageTokenObject(base.tokens || { prompt_tokens: 0, completion_tokens: 0 }),
    request: base.request,
    providerRequest: base.providerRequest || null,
    providerResponse: base.providerResponse || null,
    response: base.response || {},
    status: base.status || "success",
    ...overrides
  };
}

export function saveUsageStats({ provider, model, tokens, connectionId, apiKey, endpoint, label = "USAGE" }) {
  if (!tokens || typeof tokens !== "object") {
    tokens = { prompt_tokens: 0, completion_tokens: 0 };
  }

  const usageTotals = normalizeUsageTokens(tokens);
  const inTokens = usageTotals.promptTokens;
  const outTokens = usageTotals.completionTokens;

  const time = new Date().toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const accountSuffix = connectionId ? ` | account=${connectionId.slice(0, 8)}...` : "";
  console.log(`${COLORS.green}[${time}] 📊 [${label}] ${provider.toUpperCase()} | in=${inTokens} | out=${outTokens}${accountSuffix}${COLORS.reset}`);

  // Normalize to OpenAI token shape for storage
  const normalized = normalizeUsageTokenObject(tokens);

  saveRequestUsage({
    provider: provider || "unknown",
    model: model || "unknown",
    tokens: normalized,
    timestamp: new Date().toISOString(),
    connectionId: connectionId || undefined,
    apiKey: apiKey || undefined,
    endpoint: endpoint || null
  }).catch(() => {});
}
