import { beforeEach, describe, expect, it, vi } from "vitest";

const { saveRequestUsageMock } = vi.hoisted(() => ({
  saveRequestUsageMock: vi.fn(async () => {}),
}));

vi.mock("@/lib/usageDb.js", () => ({
  appendRequestLog: vi.fn(async () => {}),
  saveRequestDetail: vi.fn(async () => {}),
  saveRequestUsage: saveRequestUsageMock,
}));

describe("request detail usage persistence", () => {
  beforeEach(() => {
    saveRequestUsageMock.mockClear();
  });

  it("preserves estimated usage metadata while normalizing in/out tokens", async () => {
    const { saveUsageStats } = await import("../../open-sse/handlers/chatCore/requestDetail.js");

    saveUsageStats({
      provider: "openai-compatible-responses-test",
      model: "gpt-5.5-xhigh",
      tokens: {
        input_tokens: 28,
        output_tokens: 1,
        total_tokens: 29,
        estimated: true,
      },
      connectionId: "conn-test",
      apiKey: "sk-test",
      endpoint: "/v1/responses",
    });

    await vi.waitFor(() => expect(saveRequestUsageMock).toHaveBeenCalledTimes(1));
    expect(saveRequestUsageMock.mock.calls[0][0]).toMatchObject({
      provider: "openai-compatible-responses-test",
      model: "gpt-5.5-xhigh",
      endpoint: "/v1/responses",
      tokens: {
        prompt_tokens: 28,
        completion_tokens: 1,
        total_tokens: 29,
        estimated: true,
      },
    });
  });
});
