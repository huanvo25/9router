import { PROVIDERS } from "../providers/index.js";

export function isPromptCacheEnabled(provider, providerPromptCache = null) {
  const value = providerPromptCache?.[provider]?.enabled;
  if (typeof value === "boolean") return value;
  return PROVIDERS[provider]?.quirks?.disablePromptCacheByDefault !== true;
}

export function stripPromptCacheHints(value) {
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    for (const item of value) stripPromptCacheHints(item);
    return value;
  }
  delete value.cache_control;
  delete value.prompt_cache_key;
  delete value.prompt_cache_retention;
  for (const child of Object.values(value)) {
    if (child && typeof child === "object") stripPromptCacheHints(child);
  }
  return value;
}
