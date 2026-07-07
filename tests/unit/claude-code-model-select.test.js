import { describe, expect, it } from "vitest";

import { getCapabilitiesForModel } from "../../open-sse/providers/capabilities.js";
import { getModelUpstreamId } from "../../open-sse/config/providerModels.js";
import { getModelsByProviderId } from "../../src/shared/constants/models.js";
import { CLI_TOOLS } from "../../src/shared/constants/cliTools.js";

const EXPECTED_CLAUDE_CODE_OPUS_SONNET = [
  "claude-sonnet-5",
  "claude-opus-4-8",
  "claude-opus-4.8",
  "claude-opus-4-7",
  "claude-opus-4.7",
  "claude-opus-4-6",
  "claude-opus-4.6",
  "claude-sonnet-4-6",
  "claude-sonnet-4.6",
  "claude-opus-4-5-20251101",
  "claude-opus-4.5",
  "claude-sonnet-4-5-20250929",
  "claude-sonnet-4.5",
  "claude-opus-4-20250514",
  "claude-sonnet-4-20250514",
  "claude-sonnet-4",
];

describe("Claude Code extension model select", () => {
  it("exposes every Claude Opus and Sonnet option through the cc provider catalog", () => {
    const ids = getModelsByProviderId("claude").map((model) => model.id);

    expect(ids).toEqual(expect.arrayContaining(EXPECTED_CLAUDE_CODE_OPUS_SONNET));
  });

  it("maps short dotted selector ids to the Claude Code upstream ids", () => {
    expect(getModelUpstreamId("cc", "claude-opus-4.8")).toBe("claude-opus-4-8");
    expect(getModelUpstreamId("cc", "claude-opus-4.7")).toBe("claude-opus-4-7");
    expect(getModelUpstreamId("cc", "claude-opus-4.6")).toBe("claude-opus-4-6");
    expect(getModelUpstreamId("cc", "claude-sonnet-4.6")).toBe("claude-sonnet-4-6");
    expect(getModelUpstreamId("cc", "claude-opus-4.5")).toBe("claude-opus-4-5-20251101");
    expect(getModelUpstreamId("cc", "claude-sonnet-4.5")).toBe("claude-sonnet-4-5-20250929");
    expect(getModelUpstreamId("cc", "claude-sonnet-4")).toBe("claude-sonnet-4-20250514");
  });

  it("defaults Claude Code lanes to the newest Opus and Sonnet entries", () => {
    const defaults = Object.fromEntries(
      CLI_TOOLS.claude.defaultModels.map((model) => [model.alias, model.defaultValue])
    );

    expect(defaults.opus).toBe("cc/claude-opus-4-8");
    expect(defaults.sonnet).toBe("cc/claude-sonnet-5");
  });

  it("keeps the Claude Code extension alias list complete", () => {
    expect(CLI_TOOLS.claude.modelAliases).toEqual(
      expect.arrayContaining(EXPECTED_CLAUDE_CODE_OPUS_SONNET)
    );
  });

  it("keeps Sonnet 5 capability badges in the model selector", () => {
    expect(getCapabilitiesForModel("cc", "claude-sonnet-5")).toMatchObject({
      contextWindow: 1000000,
      maxOutput: 128000,
      reasoning: true,
      thinkingFormat: "claude-adaptive",
      vision: true,
    });
  });
});
