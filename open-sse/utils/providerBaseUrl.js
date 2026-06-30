import { PROVIDERS, PROVIDER_MEDIA } from "../providers/index.js";

function normalizeBaseUrl(raw) {
  if (typeof raw !== "string") return "";
  return raw.trim().replace(/\/+$/, "");
}

function stripKnownOpenAIPath(url) {
  return normalizeBaseUrl(url)
    .replace(/\/(chat\/completions|responses|embeddings|images\/(generations|edits|variations)|audio\/(speech|transcriptions|translations)|realtime\/(sessions|transcription_sessions)|files|batches|vector_stores|assistants|threads|uploads|fine_tuning\/jobs|moderations|models)$/i, "");
}

export function resolveProviderBaseUrl(providerId, credentials = null) {
  const configured = PROVIDERS[providerId]?.quirks?.configurableBaseUrl || providerId?.startsWith?.("openai-compatible-");
  const raw = configured ? credentials?.providerSpecificData?.baseUrl : "";
  const override = stripKnownOpenAIPath(raw);
  if (override) return override;

  const fromChat = PROVIDERS[providerId]?.baseUrl;
  if (fromChat) return stripKnownOpenAIPath(fromChat);

  return "";
}

export function resolveProviderEndpoint(providerId, path, credentials = null, fallbackUrl = "") {
  const base = resolveProviderBaseUrl(providerId, credentials);
  if (base) return `${base}/${String(path).replace(/^\/+/, "")}`;
  return fallbackUrl;
}

export function resolveMediaEndpoint(providerId, kind, path, credentials = null) {
  const cfgKey = `${kind}Config`;
  const fallbackUrl = PROVIDER_MEDIA[providerId]?.[cfgKey]?.baseUrl || "";
  return resolveProviderEndpoint(providerId, path, credentials, fallbackUrl);
}
