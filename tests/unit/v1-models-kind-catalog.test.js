import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const originalDataDir = process.env.DATA_DIR;

async function setupDb() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-v1-models-"));
  process.env.DATA_DIR = tempDir;
  vi.resetModules();

  const { createProviderConnection, replaceSyncedAvailableModels } = await import("@/models/index.js");
  const { buildModelsList } = await import("../../src/app/api/v1/models/route.js");

  return {
    buildModelsList,
    createProviderConnection,
    replaceSyncedAvailableModels,
    cleanup() {
      fs.rmSync(tempDir, { recursive: true, force: true });
    },
  };
}

describe("/v1/models kind catalog", () => {
  let cleanup = () => {};

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    cleanup();
    cleanup = () => {};
    if (originalDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = originalDataDir;
  });

  it("keeps static Codex image models visible when synced LLM models exist", async () => {
    const ctx = await setupDb();
    cleanup = ctx.cleanup;

    await ctx.createProviderConnection({
      provider: "codex",
      authType: "oauth",
      name: "Codex Plus",
      email: "codex@example.com",
      accessToken: "codex-token",
      refreshToken: "refresh-token",
      providerSpecificData: { chatgptPlanType: "plus" },
    });
    await ctx.replaceSyncedAvailableModels("codex", [
      { id: "gpt-5.5", name: "GPT 5.5" },
    ]);

    const imageIds = (await ctx.buildModelsList(["image"])).map((model) => model.id);
    expect(imageIds).toContain("cx/gpt-image-2");
    expect(imageIds).toContain("cx/gpt-5.5-image");

    const llmIds = (await ctx.buildModelsList(["llm"])).map((model) => model.id);
    expect(llmIds).toContain("cx/gpt-5.5");
    expect(llmIds).not.toContain("cx/gpt-image-2");
  });
});
