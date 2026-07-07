import { describe, expect, it } from "vitest";
import { MITM_TOOLS } from "../../src/shared/constants/cliTools.js";

// Guards the fix in commit 356607c: Kiro's agent/"vibe" mode sends modelId
// "auto" for the main turn and "simple-task" for background sub-tasks. Both
// need a mappable defaultModels slot — otherwise getMappedModel (src/mitm/server.js)
// returns null and the /generateAssistantResponse call is passed through to AWS
// instead of being routed to the user's chosen provider (surfacing as Kiro's
// "monthly usage limit" once the AWS quota is gone).
describe("Kiro MITM model slots", () => {
  const kiro = MITM_TOOLS.kiro;
  const modelIds = () => kiro.defaultModels.map((m) => m.id);

  it("exposes the kiro mitm tool", () => {
    expect(kiro).toBeTruthy();
    expect(kiro.configType).toBe("mitm");
    expect(Array.isArray(kiro.defaultModels)).toBe(true);
  });

  it("offers a mappable slot for the agent default model id 'auto'", () => {
    const auto = kiro.defaultModels.find((m) => m.id === "auto");
    expect(auto).toBeTruthy();
    expect(auto.alias).toBe("auto");
  });

  it("offers all current upstream Kiro model ids", () => {
    expect(modelIds()).toEqual(expect.arrayContaining([
      "auto",
      "claude-sonnet-5",
      "claude-opus-4.8",
      "claude-opus-4.7",
      "claude-opus-4.6",
      "claude-sonnet-4.6",
      "claude-opus-4.5",
      "claude-sonnet-4.5",
      "claude-sonnet-4",
      "claude-haiku-4.5",
      "deepseek-3.2",
      "minimax-m2.5",
      "minimax-m2.1",
      "glm-5",
      "qwen3-coder-next",
    ]));
  });

  it("offers a mappable slot for the background sub-task model id 'simple-task'", () => {
    const simpleTask = kiro.defaultModels.find((m) => m.id === "simple-task");
    expect(simpleTask).toBeTruthy();
    expect(simpleTask.alias).toBe("simple-task");
  });
});
