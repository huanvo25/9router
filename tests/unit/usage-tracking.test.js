import { describe, expect, it } from "vitest";

import { FORMATS } from "../../open-sse/translator/formats.js";
import { addBufferToUsage, estimateUsage } from "../../open-sse/utils/usageTracking.js";

describe("usage tracking estimates", () => {
  it("does not add the safety buffer to estimated OpenAI-compatible Responses usage", () => {
    const body = {
      model: "gpt-5.5-xhigh",
      input: "Reply with exactly: OK",
      stream: false,
      max_output_tokens: 32,
      store: false,
    };

    const usage = estimateUsage(body, "OK".length, FORMATS.OPENAI_RESPONSES);

    expect(usage).toMatchObject({
      prompt_tokens: Math.ceil(JSON.stringify(body).length / 4),
      completion_tokens: 1,
      total_tokens: Math.ceil(JSON.stringify(body).length / 4) + 1,
      estimated: true,
    });
    expect(usage.prompt_tokens).toBeLessThan(100);
  });

  it("keeps explicit buffer padding opt-in separate from estimates", () => {
    expect(addBufferToUsage({ prompt_tokens: 28, completion_tokens: 1, total_tokens: 29 }))
      .toMatchObject({ prompt_tokens: 2028, completion_tokens: 1, total_tokens: 2029 });
  });
});
