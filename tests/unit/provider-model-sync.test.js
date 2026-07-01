import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/server", () => ({
  NextResponse: {
    json(body, init = {}) {
      return new Response(JSON.stringify(body), {
        status: init.status || 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  },
}));

vi.mock("@/models", () => ({
  getProviderConnectionById: vi.fn(),
}));

vi.mock("@/shared/constants/providers", () => ({
  isOpenAICompatibleProvider: (providerId) => String(providerId).startsWith("openai-compatible-"),
  isAnthropicCompatibleProvider: (providerId) => String(providerId).startsWith("anthropic-compatible-"),
}));

vi.mock("@/lib/oauth/constants/oauth", () => ({
  ANTIGRAVITY_CONFIG: {},
  GEMINI_CONFIG: {},
}));

vi.mock("@/sse/services/tokenRefresh", () => ({
  refreshGoogleToken: vi.fn(),
  updateProviderCredentials: vi.fn(),
}));

vi.mock("open-sse/config/providers.js", () => ({
  resolveOllamaLocalHost: vi.fn(() => "http://127.0.0.1:11434"),
}));

vi.mock("open-sse/utils/providerBaseUrl.js", () => ({
  resolveProviderEndpoint: vi.fn((providerId, path, connection, fallbackUrl) => fallbackUrl),
}));

vi.mock("open-sse/config/providerModels.js", () => ({
  getModelsByProviderId: vi.fn((providerId) => {
    if (providerId === "cloudflare-ai") {
      return [
        { id: "@cf/zai-org/glm-5.2", name: "GLM 5.2" },
        { id: "@cf/openai/gpt-oss-120b", name: "GPT OSS 120B" },
      ];
    }
    return [];
  }),
}));

vi.mock("open-sse/services/kiroModels.js", () => ({
  resolveKiroModels: vi.fn(),
}));

vi.mock("open-sse/services/kimchiModels.js", () => ({
  resolveKimchiModels: vi.fn(),
}));

vi.mock("open-sse/services/qoderModels.js", () => ({
  resolveQoderModels: vi.fn(),
}));

vi.mock("open-sse/providers/registry/index.js", () => ({
  default: [
    {
      id: "venice",
      category: "apikey",
      transport: { headers: {} },
      modelsFetcher: { url: "https://api.venice.ai/api/v1/models", type: "openai" },
    },
    {
      id: "opencode",
      category: "free",
      noAuth: true,
      transport: { noAuth: true, headers: { "x-opencode-client": "desktop" } },
      modelsFetcher: { url: "https://opencode.ai/zen/v1/models", type: "opencode-free" },
    },
  ],
}));

const originalFetch = global.fetch;

describe("provider model sync fetchers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("uses registry modelsFetcher for standard API-key providers", async () => {
    const { fetchModelsForConnection } = await import("../../src/app/api/providers/[id]/models/route.js");
    global.fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      data: [
        { id: "venice-uncensored-1-2", model: "ignored" },
        { id: "deepseek-v4-pro", displayName: "DeepSeek V4 Pro" },
      ],
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));

    const result = await fetchModelsForConnection({
      id: "conn-venice",
      provider: "venice",
      authType: "apikey",
      apiKey: "test-key",
      providerSpecificData: {},
    });

    expect(result.error).toBeUndefined();
    expect(result.models).toEqual([
      expect.objectContaining({ id: "venice-uncensored-1-2", name: "venice-uncensored-1-2" }),
      expect.objectContaining({ id: "deepseek-v4-pro", name: "DeepSeek V4 Pro" }),
    ]);
    expect(global.fetch).toHaveBeenCalledWith(
      "https://api.venice.ai/api/v1/models",
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({
          Authorization: "Bearer test-key",
        }),
      }),
    );
  });

  it("can fetch models for no-auth providers without a connection row", async () => {
    const {
      createNoAuthModelsConnection,
      fetchModelsForConnection,
    } = await import("../../src/app/api/providers/[id]/models/route.js");
    global.fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      data: [
        { id: "big-pickle" },
        { id: "qwen3-coder-free" },
        { id: "paid-model" },
      ],
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));

    const connection = createNoAuthModelsConnection("opencode");
    const result = await fetchModelsForConnection(connection);

    expect(connection).toMatchObject({
      id: "opencode",
      provider: "opencode",
      authType: "noauth",
    });
    expect(result.error).toBeUndefined();
    expect(result.models.map((model) => model.id)).toEqual(["big-pickle", "qwen3-coder-free"]);
    expect(global.fetch).toHaveBeenCalledWith(
      "https://opencode.ai/zen/v1/models",
      expect.objectContaining({
        method: "GET",
        headers: expect.not.objectContaining({
          Authorization: expect.any(String),
        }),
      }),
    );
  });

  it("falls back to static provider models when no live listing endpoint exists", async () => {
    const { fetchModelsForConnection } = await import("../../src/app/api/providers/[id]/models/route.js");
    global.fetch = vi.fn();

    const result = await fetchModelsForConnection({
      id: "conn-cloudflare",
      provider: "cloudflare-ai",
      authType: "apikey",
      apiKey: "test-key",
      providerSpecificData: { accountId: "acct" },
    });

    expect(result.error).toBeUndefined();
    expect(result.warning).toMatch(/static registry models/i);
    expect(result.models).toEqual([
      expect.objectContaining({ id: "@cf/zai-org/glm-5.2", name: "GLM 5.2" }),
      expect.objectContaining({ id: "@cf/openai/gpt-oss-120b", name: "GPT OSS 120B" }),
    ]);
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
