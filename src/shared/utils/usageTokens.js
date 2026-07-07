function isObject(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

function numericToken(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : 0;
}

function maxToken(...values) {
  return Math.max(0, ...values.map(numericToken));
}

function getRawTokens(source = {}) {
  if (isObject(source.tokens)) return source.tokens;
  return isObject(source) ? source : {};
}

function getUsageObjects(source = {}) {
  const raw = getRawTokens(source);
  const objects = [];

  if (isObject(source)) objects.push(source);
  if (raw !== source && isObject(raw)) objects.push(raw);
  for (const item of [...objects]) {
    if (isObject(item.usage)) objects.push(item.usage);
    if (isObject(item.response?.usage)) objects.push(item.response.usage);
    if (isObject(item.providerResponse?.usage)) objects.push(item.providerResponse.usage);
    if (isObject(item.metricsEvent)) objects.push(item.metricsEvent);
    if (isObject(item.usageEvent)) objects.push(item.usageEvent);
  }

  return objects;
}

function getUsageMetadataObjects(source = {}) {
  const objects = [];
  for (const item of getUsageObjects(source)) {
    if (isObject(item.usageMetadata)) objects.push(item.usageMetadata);
    if (isObject(item.response?.usageMetadata)) objects.push(item.response.usageMetadata);
    if (isObject(item.providerResponse?.usageMetadata)) objects.push(item.providerResponse.usageMetadata);
  }
  return objects;
}

function getInputTokens(source = {}) {
  const usageObjects = getUsageObjects(source);
  const directPrompt = maxToken(
    ...usageObjects.flatMap((usage) => [
      usage.promptTokens,
      usage.prompt_tokens,
      usage.promptTokenCount,
      usage.prompt_eval_count,
    ])
  );
  const inputBase = maxToken(
    ...usageObjects.flatMap((usage) => [
      usage.inputTokens,
      usage.input_tokens,
    ])
  );
  const cacheReadTokens = maxToken(
    ...usageObjects.flatMap((usage) => [
      usage.cached_tokens,
      usage.cache_read_input_tokens,
      usage.prompt_tokens_details?.cached_tokens,
      usage.input_tokens_details?.cached_tokens,
    ])
  );
  const cacheCreationTokens = maxToken(
    ...usageObjects.flatMap((usage) => [
      usage.cache_creation_input_tokens,
      usage.prompt_tokens_details?.cache_creation_tokens,
    ])
  );
  const cacheTokens = cacheReadTokens + cacheCreationTokens;
  const metadataPrompt = maxToken(
    ...getUsageMetadataObjects(source).flatMap((usage) => [
      usage.promptTokenCount,
      usage.totalTokenCount && !usage.candidatesTokenCount && !usage.thoughtsTokenCount ? usage.totalTokenCount : undefined,
    ])
  );

  if (directPrompt > 0) return Math.max(directPrompt, cacheTokens);
  if (inputBase > 0) return inputBase + cacheTokens;
  return Math.max(metadataPrompt, cacheTokens);
}

function getOutputTokens(source = {}) {
  const usageObjects = getUsageObjects(source);
  const directOutput = maxToken(
    ...usageObjects.flatMap((usage) => [
      usage.completionTokens,
      usage.completion_tokens,
      usage.outputTokens,
      usage.output_tokens,
      usage.eval_count,
      usage.reasoning_tokens,
      usage.completion_tokens_details?.reasoning_tokens,
      usage.output_tokens_details?.reasoning_tokens,
    ])
  );
  const metadataOutput = maxToken(
    ...getUsageMetadataObjects(source).flatMap((usage) => {
      const prompt = numericToken(usage.promptTokenCount);
      const total = numericToken(usage.totalTokenCount);
      const thoughts = numericToken(usage.thoughtsTokenCount);
      let candidates = numericToken(usage.candidatesTokenCount);
      if (candidates <= 0 && total > 0) {
        candidates = Math.max(0, total - prompt - thoughts);
      }
      return [candidates + thoughts];
    })
  );

  return Math.max(directOutput, metadataOutput);
}

export function normalizeUsageTokens(source = {}) {
  const promptTokens = getInputTokens(source);
  const completionTokens = getOutputTokens(source);
  const explicitTotal = maxToken(
    ...getUsageObjects(source).flatMap((usage) => [
      usage.totalTokens,
      usage.total_tokens,
      usage.totalTokenCount,
    ]),
    ...getUsageMetadataObjects(source).map((usage) => usage.totalTokenCount)
  );
  const totalTokens = Math.max(explicitTotal, promptTokens + completionTokens);

  return { promptTokens, completionTokens, totalTokens };
}

export function normalizeUsageTokenObject(source = {}) {
  const raw = getRawTokens(source);
  const normalized = normalizeUsageTokens(source);
  return {
    ...raw,
    prompt_tokens: normalized.promptTokens,
    completion_tokens: normalized.completionTokens,
    total_tokens: normalized.totalTokens,
  };
}

export function isUsageOkStatus(status) {
  const value = String(status || "").trim().toLowerCase();
  return !value || value === "ok" || value === "success" || /^2\d\d\b/.test(value);
}

export function getUsageErrorInfo(source = {}) {
  const tokens = normalizeUsageTokens(source);
  const statusError = !isUsageOkStatus(source.status);
  const inputZero = tokens.promptTokens <= 0;
  const outputZero = tokens.completionTokens <= 0;
  const reasons = [];

  if (statusError) reasons.push(`status:${source.status || "unknown"}`);
  if (inputZero) reasons.push("input=0");
  if (outputZero) reasons.push("output=0");

  return {
    ...tokens,
    isError: statusError || inputZero || outputZero,
    statusError,
    zeroTokenError: inputZero || outputZero,
    inputZero,
    outputZero,
    reason: reasons.join(", "),
  };
}
