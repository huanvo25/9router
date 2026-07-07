import { describe, expect, it } from "vitest";
import { getUsageErrorInfo, normalizeUsageTokenObject, normalizeUsageTokens } from "@/shared/utils/usageTokens";

describe("usage token normalization", () => {
  it("normalizes OpenAI and treats 2xx status as ok", () => {
    const info = getUsageErrorInfo({
      status: "200 OK",
      tokens: { prompt_tokens: 12, completion_tokens: 4 },
    });

    expect(info).toMatchObject({
      promptTokens: 12,
      completionTokens: 4,
      totalTokens: 16,
      isError: false,
    });
  });

  it("normalizes Claude raw input/output with cache tokens", () => {
    expect(normalizeUsageTokens({
      input_tokens: 10,
      output_tokens: 5,
      cache_read_input_tokens: 3,
      cache_creation_input_tokens: 2,
    })).toMatchObject({
      promptTokens: 15,
      completionTokens: 5,
      totalTokens: 20,
    });
  });

  it("normalizes Gemini usageMetadata including thoughts and total fallback", () => {
    expect(normalizeUsageTokens({
      usageMetadata: {
        promptTokenCount: 100,
        candidatesTokenCount: 0,
        thoughtsTokenCount: 10,
        totalTokenCount: 150,
      },
    })).toMatchObject({
      promptTokens: 100,
      completionTokens: 50,
      totalTokens: 150,
    });
  });

  it("normalizes Kiro and command-style camelCase tokens", () => {
    const normalized = normalizeUsageTokenObject({
      inputTokens: 12,
      outputTokens: 3,
      totalTokens: 15,
    });

    expect(normalized).toMatchObject({
      inputTokens: 12,
      outputTokens: 3,
      prompt_tokens: 12,
      completion_tokens: 3,
      total_tokens: 15,
    });
  });

  it("normalizes Ollama eval token fields", () => {
    expect(normalizeUsageTokens({
      prompt_eval_count: 9,
      eval_count: 2,
    })).toMatchObject({
      promptTokens: 9,
      completionTokens: 2,
      totalTokens: 11,
    });
  });

  it("flags any provider shape with input or output zero", () => {
    const info = getUsageErrorInfo({
      provider: "kiro",
      status: "success",
      tokens: { inputTokens: 20, outputTokens: 0 },
    });

    expect(info).toMatchObject({
      isError: true,
      inputZero: false,
      outputZero: true,
      reason: "output=0",
    });
  });
});
