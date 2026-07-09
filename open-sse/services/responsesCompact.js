/**
 * Helpers for OpenAI/Codex Responses API context compaction.
 *
 * Codex CLI triggers automatic compaction by sending a terminal top-level
 * `{ type: "compaction_trigger" }` item to `/responses`.  The upstream Codex
 * backend expects that turn to be replayed against `/responses/compact`, then
 * the proxy must synthesize a tiny Responses SSE stream containing the single
 * encrypted compaction item.
 */

export class CompactionTriggerError extends Error {
  constructor(message) {
    super(message);
    this.name = "CompactionTriggerError";
    this.param = "input";
  }
}

function isPlainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

function isCompactionTriggerItem(item) {
  return isPlainObject(item) && item.type === "compaction_trigger";
}

function normalizeContentForResponses(role, content) {
  const textType = role === "assistant" ? "output_text" : "input_text";
  if (typeof content === "string") return [{ type: textType, text: content }];
  if (!Array.isArray(content)) return content ?? "";
  return content.map((part) => {
    if (!isPlainObject(part)) return part;
    if (part.type === "text" && typeof part.text === "string") return { type: textType, text: part.text };
    if (part.type === "image_url") {
      const url = typeof part.image_url === "string" ? part.image_url : part.image_url?.url;
      return { type: "input_image", image_url: url || "", detail: part.image_url?.detail || part.detail || "auto" };
    }
    return part;
  });
}

function coerceMessagesToCompactInput(body) {
  if (!Array.isArray(body?.messages)) return null;
  const input = [];
  const instructionParts = [];
  if (typeof body.instructions === "string" && body.instructions) instructionParts.push(body.instructions);

  for (const msg of body.messages) {
    if (!isPlainObject(msg)) continue;
    const role = msg.role || "user";
    if (role === "system" || role === "developer") {
      if (typeof msg.content === "string") instructionParts.push(msg.content);
      else if (Array.isArray(msg.content)) {
        const text = msg.content.map((p) => typeof p?.text === "string" ? p.text : "").filter(Boolean).join("\n");
        if (text) instructionParts.push(text);
      }
      continue;
    }
    input.push({ type: "message", role, content: normalizeContentForResponses(role, msg.content) });
  }

  return { input, instructions: instructionParts.join("\n\n") };
}

/**
 * Return input with a terminal compaction_trigger removed, null when absent.
 * Reject malformed placement to match codex-lb/OpenAI-compatible behavior.
 */
export function stripTerminalCompactionTriggerInput(body) {
  const input = body?.input;
  if (!Array.isArray(input)) return null;

  const stripped = [];
  let triggerSeen = false;
  const lastIndex = input.length - 1;

  for (let index = 0; index < input.length; index++) {
    const item = input[index];
    if (!isCompactionTriggerItem(item)) {
      stripped.push(item);
      continue;
    }

    if (triggerSeen || index !== lastIndex) {
      throw new CompactionTriggerError("compaction_trigger must appear exactly once as the final top-level input item");
    }
    triggerSeen = true;
  }

  return triggerSeen ? stripped : null;
}

/**
 * Build the compact endpoint payload from a Responses API request body.
 * Keeps only fields accepted by Codex `/responses/compact` plus routing extras.
 */
export function buildResponsesCompactBody(body, inputOverride = null) {
  const coerced = inputOverride === null && body?.input === undefined ? coerceMessagesToCompactInput(body) : null;
  const compact = {
    model: body?.model,
    instructions: coerced?.instructions ?? (typeof body?.instructions === "string" ? body.instructions : ""),
    input: inputOverride ?? body?.input ?? coerced?.input ?? []
  };

  if (body?.reasoning && typeof body.reasoning === "object") compact.reasoning = body.reasoning;
  if (typeof body?.service_tier === "string") compact.service_tier = body.service_tier;
  if (typeof body?.prompt_cache_key === "string") compact.prompt_cache_key = body.prompt_cache_key;
  if (typeof body?.promptCacheKey === "string" && !compact.prompt_cache_key) compact.prompt_cache_key = body.promptCacheKey;
  if (typeof body?.previous_response_id === "string") compact.previous_response_id = body.previous_response_id;
  if (typeof body?.conversation === "string") compact.conversation = body.conversation;

  // Internal marker consumed by CodexExecutor to hit `/responses/compact`.
  compact._compact = true;
  return compact;
}

export function extractCompactOutputItem(payload) {
  const output = Array.isArray(payload?.output) ? payload.output : [];
  for (const rawItem of output) {
    if (!isPlainObject(rawItem)) continue;
    const itemType = rawItem.type;
    const encryptedContent = rawItem.encrypted_content;
    if ((itemType === "compaction" || itemType === "compaction_summary") && typeof encryptedContent === "string") {
      return { type: "compaction", encrypted_content: encryptedContent };
    }
  }

  const summary = isPlainObject(payload?.compaction_summary) ? payload.compaction_summary : null;
  if (typeof summary?.encrypted_content === "string") {
    return { type: "compaction", encrypted_content: summary.encrypted_content };
  }

  return null;
}

export function compactResponseId(payload) {
  return typeof payload?.id === "string" && payload.id ? payload.id : `resp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function formatResponsesSseEvent(type, data) {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
}

export function buildSyntheticCompactionSseStream(compactPayload) {
  const item = extractCompactOutputItem(compactPayload);
  if (!item) return null;

  const response = {
    id: compactResponseId(compactPayload),
    object: "response",
    status: "completed",
    output: [item]
  };
  if (compactPayload?.usage && typeof compactPayload.usage === "object") response.usage = compactPayload.usage;

  const body = [
    formatResponsesSseEvent("response.output_item.done", { output_index: 0, item }),
    formatResponsesSseEvent("response.completed", { response }),
    "data: [DONE]\n\n"
  ].join("");

  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(body));
      controller.close();
    }
  });
}
