import { beforeEach, describe, expect, it, vi } from "vitest";

const fetchMock = vi.fn();
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: (...args) => fetchMock(...args),
}));

const { CodexExecutor } = await import("../../open-sse/executors/codex.js");
const {
  buildResponsesCompactBody,
  buildSyntheticCompactionSseStream,
  stripTerminalCompactionTriggerInput,
} = await import("../../open-sse/services/responsesCompact.js");

async function readStream(stream) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let out = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    out += decoder.decode(value, { stream: true });
  }
  return out;
}

beforeEach(() => fetchMock.mockReset());

describe("Codex Responses compaction", () => {
  it("strips only a terminal compaction_trigger", () => {
    const input = [{ role: "user", content: "hello" }, { type: "compaction_trigger" }];
    expect(stripTerminalCompactionTriggerInput({ input })).toEqual([{ role: "user", content: "hello" }]);
    expect(stripTerminalCompactionTriggerInput({ input: [{ role: "user", content: "hello" }] })).toBeNull();
    expect(() => stripTerminalCompactionTriggerInput({ input: [{ type: "compaction_trigger" }, { role: "user", content: "hello" }] })).toThrow(/final top-level input item/);
  });

  it("builds compact payload from messages when /responses/compact callers send chat shape", () => {
    const compact = buildResponsesCompactBody({
      model: "cx/gpt-5.3-codex",
      messages: [
        { role: "system", content: "be concise" },
        { role: "user", content: "hello" },
      ],
      reasoning: { effort: "low" },
    });

    expect(compact._compact).toBe(true);
    expect(compact.instructions).toBe("be concise");
    expect(compact.input).toEqual([
      { type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] },
    ]);
  });

  it("sends compact calls to /responses/compact and strips unsupported compact fields", async () => {
    const executor = new CodexExecutor();
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ object: "response.compaction", output: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));

    const result = await executor.execute({
      model: "gpt-5.3-codex",
      body: {
        _compact: true,
        model: "gpt-5.3-codex",
        instructions: "compact",
        input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] }],
        tools: [{ type: "function", name: "x" }],
        include: ["reasoning.encrypted_content"],
        stream: true,
        store: true,
        previous_response_id: "resp_anchor",
        conversation: "conv_anchor",
      },
      stream: true,
      credentials: { accessToken: "tok", connectionId: "conn", providerSpecificData: {} },
    });

    expect(result.url).toMatch(/\/responses\/compact$/);
    const sent = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(sent.stream).toBeUndefined();
    expect(sent.store).toBeUndefined();
    expect(sent.tools).toBeUndefined();
    expect(sent.include).toBeUndefined();
    expect(sent.previous_response_id).toBe("resp_anchor");
    expect(sent.conversation).toBe("conv_anchor");
  });

  it("builds the synthetic compaction SSE stream expected by Codex CLI", async () => {
    const stream = buildSyntheticCompactionSseStream({
      id: "resp_compact",
      object: "response.compaction",
      compaction_summary: { encrypted_content: "enc_summary", summary_text: "summary" },
      usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
    });

    const text = await readStream(stream);
    expect(text).toContain("event: response.output_item.done");
    expect(text).toContain('"type":"compaction"');
    expect(text).toContain('"encrypted_content":"enc_summary"');
    expect(text).toContain("event: response.completed");
    expect(text.trim().endsWith("data: [DONE]")).toBe(true);
  });
});
