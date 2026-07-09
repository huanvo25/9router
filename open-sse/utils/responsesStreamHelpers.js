// Helpers for OpenAI Responses API streaming termination + event framing
import { FORMATS } from "../translator/formats.js";
import { formatSSE } from "./streamHelpers.js";

// Responses API events that signal the stream has reached a terminal state
const OPENAI_RESPONSES_TERMINAL_EVENTS = new Set([
  "response.completed",
  "response.done",
  "response.failed",
  "error"
]);

const PUBLIC_RESPONSE_OUTPUT_ITEM_TYPES = new Set([
  "message",
  "function_call",
  "function_call_output",
  "reasoning",
  "web_search_call",
  "file_search_call",
  "computer_call",
  "code_interpreter_call",
  "mcp_approval_request",
  "mcp_list_tools",
  "output_image",
]);

export function getOpenAIResponsesEventName(eventName, chunk) {
  if (eventName) return eventName;
  if (chunk && typeof chunk.type === "string") return chunk.type;
  return null;
}

export function isOpenAIResponsesTerminalEvent(eventName, chunk) {
  const type = getOpenAIResponsesEventName(eventName, chunk);
  if (OPENAI_RESPONSES_TERMINAL_EVENTS.has(type)) return true;
  const status = chunk?.response?.status;
  return status === "completed" || status === "failed";
}

function isObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isPublicOutputItemType(type) {
  return PUBLIC_RESPONSE_OUTPUT_ITEM_TYPES.has(type) || type.endsWith("_call") || type.endsWith("_call_output");
}

function textFromOutputItem(item) {
  if (!isObject(item)) return null;
  if (typeof item.text === "string" && item.text) return item.text;
  if (Array.isArray(item.content)) {
    const text = item.content
      .map((part) => {
        if (typeof part === "string") return part;
        if (!isObject(part)) return "";
        if (typeof part.text === "string") return part.text;
        if (typeof part.output_text === "string") return part.output_text;
        return "";
      })
      .join("");
    if (text) return text;
  }
  return null;
}

function normalizePublicOutputItem(item) {
  if (!isObject(item)) return null;
  const type = typeof item.type === "string" ? item.type : "";
  if (type && isPublicOutputItemType(type)) return { ...item };

  const text = textFromOutputItem(item);
  if (text === null) return null;
  const normalized = {
    type: "message",
    role: "assistant",
    status: typeof item.status === "string" ? item.status : "completed",
    content: [{ type: "output_text", text }],
  };
  if (typeof item.id === "string" && item.id) normalized.id = item.id;
  return normalized;
}

function normalizeResponseOutput(response, outputItems) {
  if (!isObject(response)) return null;
  const next = { ...response };
  const existing = Array.isArray(next.output) ? next.output : [];
  if (existing.length === 0 && outputItems.size > 0) {
    next.output = [...outputItems.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, item]) => item);
  }

  if (Array.isArray(next.output)) {
    next.output = next.output
      .map(normalizePublicOutputItem)
      .filter(Boolean);
  }
  return next;
}

function syntheticResponseCreated(payload, fallbackId) {
  const source = isObject(payload?.response) ? payload.response : {};
  const response = {
    ...source,
    id: typeof source.id === "string" && source.id ? source.id : fallbackId,
    object: source.object || "response",
    created_at: source.created_at || Math.floor(Date.now() / 1000),
    status: "in_progress",
    output: [],
  };
  const event = { type: "response.created", response };
  if (Number.isInteger(payload?.sequence_number)) event.sequence_number = payload.sequence_number;
  return event;
}

function responseFailedPayload(code, message, responseId = null) {
  return {
    type: "response.failed",
    response: {
      id: responseId || `resp_${code || "stream_error"}`,
      object: "response",
      created_at: Math.floor(Date.now() / 1000),
      status: "failed",
      error: {
        type: "server_error",
        code: code || "stream_error",
        message: message || "Upstream Responses stream failed",
      },
    },
  };
}

function textDeltaKey(payload) {
  return `${typeof payload?.item_id === "string" ? payload.item_id : ""}:${Number.isInteger(payload?.output_index) ? payload.output_index : ""}`;
}

function outputItemKey(outputIndex, item) {
  return `${typeof item?.id === "string" ? item.id : ""}:${Number.isInteger(outputIndex) ? outputIndex : ""}`;
}

function maybeSyntheticTextDelta(payload, state) {
  if (payload?.type !== "response.output_item.done") return null;
  const outputIndex = payload.output_index;
  if (!Number.isInteger(outputIndex)) return null;
  const item = normalizePublicOutputItem(payload.item);
  const text = textFromOutputItem(item);
  if (!text) return null;
  const key = outputItemKey(outputIndex, item);
  if (state.seenTextDeltas.has(key) || state.seenTextDeltas.has(`:${outputIndex}`)) return null;
  state.seenTextDeltas.add(key);
  const event = {
    type: "response.output_text.delta",
    output_index: outputIndex,
    content_index: 0,
    delta: text,
  };
  if (typeof item.id === "string" && item.id) event.item_id = item.id;
  return event;
}

export function createOpenAIResponsesPublicNormalizerState() {
  return {
    createdEmitted: false,
    terminalSeen: false,
    outputItems: new Map(),
    seenTextDeltas: new Set(),
    syntheticResponseId: `resp_${Date.now()}`,
    responseId: null,
  };
}

export function normalizeOpenAIResponsesPublicEvent(eventName, payload, state) {
  const eventType = getOpenAIResponsesEventName(eventName, payload);
  if (!eventType || !payload || typeof payload !== "object") return [];

  if (eventType.startsWith("codex.")) return [];

  let normalized = { ...payload, type: payload.type || eventType };
  if (eventType === "response.output_text.delta") {
    state.seenTextDeltas.add(textDeltaKey(normalized));
  }

  if ((eventType === "response.output_item.added" || eventType === "response.output_item.done") && isObject(normalized.item)) {
    const item = normalizePublicOutputItem(normalized.item);
    if (!item) return [];
    normalized = { ...normalized, item };
  }

  if (eventType === "response.output_item.done" && Number.isInteger(normalized.output_index) && isObject(normalized.item)) {
    state.outputItems.set(normalized.output_index, normalized.item);
  }

  if ((eventType === "response.completed" || eventType === "response.incomplete") && isObject(normalized.response)) {
    const response = normalizeResponseOutput(normalized.response, state.outputItems);
    if (!response) return [responseFailedPayload("invalid_response", "Upstream response.completed payload is invalid")];
    normalized = { ...normalized, response };
  }

  const out = [];
  if (!state.createdEmitted) {
    if (eventType === "response.created") {
      state.createdEmitted = true;
      if (typeof normalized.response?.id === "string" && normalized.response.id) {
        state.responseId = normalized.response.id;
        state.syntheticResponseId = normalized.response.id;
      }
    } else if (eventType.startsWith("response.") || eventType === "error") {
      out.push(syntheticResponseCreated(normalized, state.syntheticResponseId));
      state.responseId = out[0]?.response?.id || state.syntheticResponseId;
      state.createdEmitted = true;
    }
  } else if (eventType === "response.created") {
    return out;
  }

  const syntheticDelta = maybeSyntheticTextDelta(normalized, state);
  if (syntheticDelta) out.push(syntheticDelta);
  out.push(normalized);

  if (isOpenAIResponsesTerminalEvent(eventType, normalized)) {
    state.terminalSeen = true;
  }

  return out;
}

export function flushOpenAIResponsesPublicNormalizer(state) {
  if (state.terminalSeen) return [];
  const failed = responseFailedPayload(
    "stream_disconnected",
    "stream closed before response.completed",
    state.createdEmitted ? (state.responseId || state.syntheticResponseId) : null,
  );
  if (state.createdEmitted) return [failed];
  return [syntheticResponseCreated(failed, state.syntheticResponseId), failed];
}

const sharedEncoder = new TextEncoder();

// Encoded response.failed + [DONE] payload for aborted/stalled Responses passthrough streams
export function buildAbortedResponsesTerminalBytes() {
  return sharedEncoder.encode(`${formatIncompleteOpenAIResponsesStreamFailure()}data: [DONE]\n\n`);
}

// Synthesize a response.failed event for streams that close without a terminal event
export function formatIncompleteOpenAIResponsesStreamFailure() {
  return formatSSE({
    event: "response.failed",
    data: {
      type: "response.failed",
      response: {
        id: `resp_${Date.now()}`,
        status: "failed",
        error: {
          type: "stream_error",
          code: "stream_disconnected",
          message: "stream closed before response.completed"
        }
      }
    }
  }, FORMATS.OPENAI_RESPONSES);
}
