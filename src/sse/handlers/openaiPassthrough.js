import {
  getProviderCredentials,
  markAccountUnavailable,
  clearAccountError,
  extractApiKey,
  isValidApiKey,
} from "../services/auth.js";
import { getSettings } from "@/lib/localDb";
import { getModelInfo } from "../services/model.js";
import { resolveProviderId } from "@/shared/constants/providers.js";
import { errorResponse, unavailableResponse } from "open-sse/utils/error.js";
import { HTTP_STATUS } from "open-sse/config/runtimeConfig.js";
import { resolveProviderEndpoint } from "open-sse/utils/providerBaseUrl.js";
import { PROVIDERS } from "open-sse/config/providers.js";
import { proxyAwareFetch } from "open-sse/utils/proxyFetch.js";
import * as log from "../utils/logger.js";

const OPENAI_COMPAT_PREFIX = "openai-compatible-";
const DEFAULT_PROVIDER = "cliproxyapi";

function isOpenAIUpstreamProvider(provider) {
  return provider === "openai" || provider === "cliproxyapi" || provider?.startsWith?.(OPENAI_COMPAT_PREFIX);
}

function proxyOptionsFromCredentials(credentials) {
  return {
    connectionProxyEnabled: credentials?.providerSpecificData?.connectionProxyEnabled === true,
    connectionProxyUrl: credentials?.providerSpecificData?.connectionProxyUrl || "",
    connectionNoProxy: credentials?.providerSpecificData?.connectionNoProxy || "",
    vercelRelayUrl: credentials?.providerSpecificData?.vercelRelayUrl || "",
  };
}

function buildUpstreamHeaders(credentials, contentType = null) {
  const key = credentials?.apiKey || credentials?.accessToken;
  const headers = { Authorization: `Bearer ${key}` };
  if (contentType) headers["Content-Type"] = contentType;
  return headers;
}

async function parseRequestBody(request) {
  const contentType = request.headers.get("content-type") || "";
  const contentLength = request.headers.get("content-length");
  const hasBody = contentLength == null || Number(contentLength) > 0;
  if (request.method === "GET" || request.method === "DELETE" || !hasBody) {
    return { body: null, modelStr: null, contentType: null, kind: "empty" };
  }
  if (contentType.includes("multipart/form-data")) {
    const formData = await request.formData();
    return { body: formData, modelStr: formData.get("model"), contentType: null, kind: "form" };
  }
  const json = await request.json();
  return { body: json, modelStr: json?.model, contentType: "application/json", kind: "json" };
}

function resolveProviderFromRequest(request, parsed, endpointPath) {
  const url = new URL(request.url);
  const explicit = url.searchParams.get("provider") || request.headers.get("x-9router-provider") || request.headers.get("x-provider");
  if (explicit) return { provider: explicit, model: null, routedByModel: false };

  if (parsed.modelStr) return null;

  const jsonProvider = parsed.kind === "json" ? parsed.body?.provider : null;
  if (jsonProvider) return { provider: jsonProvider, model: null, routedByModel: false };

  if (/^(files|batches|vector_stores|assistants|threads|uploads|fine_tuning\/jobs|moderations|realtime\/transcription_sessions)/.test(endpointPath)) {
    return { provider: DEFAULT_PROVIDER, model: null, routedByModel: false };
  }

  return null;
}

function stripProviderQuery(request) {
  const url = new URL(request.url);
  url.searchParams.delete("provider");
  const qs = url.searchParams.toString();
  return qs ? `?${qs}` : "";
}

function cloneHeaders(response) {
  const headers = new Headers();
  const keep = ["content-type", "content-disposition", "cache-control", "openai-processing-ms", "x-request-id"];
  for (const key of keep) {
    const value = response.headers.get(key);
    if (value) headers.set(key, value);
  }
  headers.set("Access-Control-Allow-Origin", "*");
  return headers;
}

export async function handleOpenAIPassthrough(request, endpointPath) {
  let parsed;
  try {
    parsed = await parseRequestBody(request);
  } catch {
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid request body");
  }

  const settings = await getSettings();
  if (settings.requireApiKey) {
    const apiKey = extractApiKey(request);
    if (!apiKey) return errorResponse(HTTP_STATUS.UNAUTHORIZED, "Missing API key");
    const valid = await isValidApiKey(apiKey);
    if (!valid) return errorResponse(HTTP_STATUS.UNAUTHORIZED, "Invalid API key");
  }

  let provider;
  let model = null;
  let routedByModel = false;
  const providerRoute = resolveProviderFromRequest(request, parsed, endpointPath);
  if (providerRoute) {
    ({ provider, model, routedByModel } = providerRoute);
    provider = resolveProviderId(provider);
  } else {
    if (!parsed.modelStr) return errorResponse(HTTP_STATUS.BAD_REQUEST, "Missing model");
    const modelInfo = await getModelInfo(parsed.modelStr);
    if (!modelInfo.provider) return errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid model format");
    ({ provider, model } = modelInfo);
    routedByModel = true;
  }

  if (!isOpenAIUpstreamProvider(provider)) {
    return errorResponse(HTTP_STATUS.BAD_REQUEST, `Provider '${provider}' does not support OpenAI passthrough endpoint /${endpointPath}`);
  }

  log.request(request.method || "POST", `/v1/${endpointPath} | ${model ? `${provider}/${model}` : provider}`);

  let upstreamBody = parsed.body;
  if (routedByModel && parsed.kind === "form") {
    upstreamBody.set("model", model);
  } else if (routedByModel && parsed.kind === "json") {
    upstreamBody = JSON.stringify({ ...upstreamBody, model });
  } else if (parsed.kind === "json") {
    const { provider: _provider, ...bodyWithoutProvider } = upstreamBody || {};
    upstreamBody = JSON.stringify(bodyWithoutProvider);
  }

  const excludeConnectionIds = new Set();
  let lastError = null;
  let lastStatus = null;

  while (true) {
    const credentials = await getProviderCredentials(provider, excludeConnectionIds, model);
    if (!credentials || credentials.allRateLimited) {
      if (credentials?.allRateLimited) {
        const msg = lastError || credentials.lastError || "Unavailable";
        const status = lastStatus || Number(credentials.lastErrorCode) || HTTP_STATUS.SERVICE_UNAVAILABLE;
        return unavailableResponse(status, `[${provider}/${model}] ${msg}`, credentials.retryAfter, credentials.retryAfterHuman);
      }
      if (excludeConnectionIds.size === 0) return errorResponse(HTTP_STATUS.BAD_REQUEST, `No credentials for provider: ${provider}`);
      return errorResponse(lastStatus || HTTP_STATUS.SERVICE_UNAVAILABLE, lastError || "All accounts unavailable");
    }

    const fallbackUrl = provider === "openai"
      ? `https://api.openai.com/v1/${endpointPath}`
      : PROVIDERS[provider]?.baseUrl;
    const url = `${resolveProviderEndpoint(provider, endpointPath, credentials, fallbackUrl)}${stripProviderQuery(request)}`;
    const response = await proxyAwareFetch(url, {
      method: request.method || "POST",
      headers: buildUpstreamHeaders(credentials, parsed.contentType),
      body: upstreamBody,
    }, proxyOptionsFromCredentials(credentials));

    if (response.ok) {
      await clearAccountError(credentials.connectionId, credentials, model);
      return new Response(response.body, { status: response.status, headers: cloneHeaders(response) });
    }

    const errorText = await response.text().catch(() => "");
    const status = response.status || HTTP_STATUS.BAD_GATEWAY;
    const { shouldFallback } = await markAccountUnavailable(credentials.connectionId, status, errorText, provider, model);
    if (shouldFallback) {
      excludeConnectionIds.add(credentials.connectionId);
      lastError = errorText || `Upstream ${status}`;
      lastStatus = status;
      continue;
    }

    return new Response(errorText || JSON.stringify({ error: `Upstream ${status}` }), {
      status,
      headers: { "Content-Type": response.headers.get("content-type") || "application/json", "Access-Control-Allow-Origin": "*" },
    });
  }
}
