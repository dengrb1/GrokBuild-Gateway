import type { Protocol } from "./types.js";
import {
  asArray,
  asObject,
  asString,
  isObject,
  newId,
  type JsonObject,
} from "./types.js";
import {
  anthropicResponseToChat,
  chatResponseToAnthropic,
  chatResponseToResponses,
  responsesResponseToChat,
} from "./convert-response.js";
import { stringifyToolArguments } from "./tools.js";

/**
 * Parse SSE text into discrete events: { event?, data }[].
 * Handles multi-line data: fields joined by \n.
 */
export function parseSseChunk(buffer: string): {
  events: Array<{ event?: string; data: string }>;
  rest: string;
} {
  const normalized = buffer.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const parts = normalized.split("\n\n");
  const rest = parts.pop() ?? "";
  const events: Array<{ event?: string; data: string }> = [];
  for (const part of parts) {
    if (!part.trim()) continue;
    let event: string | undefined;
    const dataLines: string[] = [];
    for (const line of part.split("\n")) {
      if (line.startsWith(":") || line.trim() === "") continue;
      if (line.startsWith("event:")) {
        event = line.slice(6).trim();
      } else if (line.startsWith("data:")) {
        dataLines.push(line.slice(5).replace(/^ /, ""));
      }
    }
    if (dataLines.length) {
      events.push({ event, data: dataLines.join("\n") });
    }
  }
  return { events, rest };
}

function encodeSse(data: string, event?: string): string {
  const lines: string[] = [];
  if (event) lines.push(`event: ${event}`);
  for (const line of data.split("\n")) {
    lines.push(`data: ${line}`);
  }
  lines.push("");
  lines.push("");
  return lines.join("\n");
}

type StreamState = {
  id: string;
  model: string;
  // for anthropic tool_use assembly when converting to chat
  toolIndexById: Map<string, number>;
  nextToolIndex: number;
  // Responses function calls are keyed by every identifier the provider may
  // use for an event: call_id, item_id, item.id, and output_index.
  responsesCalls: ResponsesCallState[];
  responsesCallByKey: Map<string, ResponsesCallState>;
  responsesText: string;
  finishSent: boolean;
  doneSent: boolean;
};

type ResponsesCallState = {
  index: number;
  callId: string;
  itemId?: string;
  outputIndex?: number;
  name: string;
  arguments: string;
  emitted: boolean;
};

function newState(): StreamState {
  return {
    id: newId("chatcmpl"),
    model: "",
    toolIndexById: new Map(),
    nextToolIndex: 0,
    responsesCalls: [],
    responsesCallByKey: new Map(),
    responsesText: "",
    finishSent: false,
    doneSent: false,
  };
}

/** Convert a single upstream SSE data payload into zero+ client payloads. */
function convertSseData(
  data: string,
  eventName: string | undefined,
  from: Protocol,
  to: Protocol,
  state: StreamState,
): string[] {
  if (data === "[DONE]") {
    return to === "chat_completions" || to === "responses" ? ["[DONE]"] : [];
  }

  let json: JsonObject;
  try {
    const parsed: unknown = JSON.parse(data);
    if (!isObject(parsed)) return from === to ? [data] : [];
    json = parsed;
  } catch {
    return from === to ? [data] : [];
  }

  if (from === to) {
    return [JSON.stringify(json)];
  }

  // ── anthropic stream → chat ──
  if (from === "messages" && to === "chat_completions") {
    return anthropicSseToChat(json, eventName, state);
  }
  // ── chat stream → anthropic ──
  if (from === "chat_completions" && to === "messages") {
    return chatSseToAnthropic(json, state);
  }
  // ── responses stream → chat ──
  if (from === "responses" && to === "chat_completions") {
    return responsesSseToChat(json, eventName, state);
  }
  // ── chat stream → responses ──
  if (from === "chat_completions" && to === "responses") {
    return chatSseToResponses(json, state);
  }
  // ── via chat intermediate for other pairs ──
  if (from === "messages" && to === "responses") {
    const chatChunks = anthropicSseToChat(json, eventName, state);
    const out: string[] = [];
    for (const c of chatChunks) {
      if (c === "[DONE]") {
        out.push("[DONE]");
        continue;
      }
      try {
        const chatJson = JSON.parse(c) as JsonObject;
        out.push(...chatSseToResponses(chatJson, state));
      } catch {
        // skip
      }
    }
    return out;
  }
  if (from === "responses" && to === "messages") {
    const chatChunks = responsesSseToChat(json, eventName, state);
    const out: string[] = [];
    for (const c of chatChunks) {
      if (c === "[DONE]") {
        state.doneSent = true;
        continue;
      }
      try {
        const chatJson = JSON.parse(c) as JsonObject;
        out.push(...chatSseToAnthropic(chatJson, state));
      } catch {
        // skip
      }
    }
    return out;
  }

  // non-stream-shaped full object in SSE (rare) — convert whole response
  try {
    if (from === "messages" && to === "chat_completions" && json.type === "message") {
      return [JSON.stringify(anthropicResponseToChat(json))];
    }
    if (from === "chat_completions" && to === "messages" && json.choices) {
      return [JSON.stringify(chatResponseToAnthropic(json))];
    }
    if (from === "responses" && to === "chat_completions" && json.output) {
      return [JSON.stringify(responsesResponseToChat(json))];
    }
    if (from === "chat_completions" && to === "responses" && json.choices) {
      return [JSON.stringify(chatResponseToResponses(json))];
    }
  } catch {
    // ignore
  }

  return [];
}

function anthropicSseToChat(
  json: JsonObject,
  eventName: string | undefined,
  state: StreamState,
): string[] {
  const type = asString(json.type || eventName);
  const out: string[] = [];

  const base = () => ({
    id: state.id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: state.model || "",
  });

  if (type === "message_start") {
    const msg = asObject(json.message);
    state.id = asString(msg.id, state.id);
    state.model = asString(msg.model, state.model);
    out.push(
      JSON.stringify({
        ...base(),
        choices: [
          {
            index: 0,
            delta: { role: "assistant", content: "" },
            finish_reason: null,
          },
        ],
      }),
    );
    return out;
  }

  if (type === "content_block_start") {
    const block = asObject(json.content_block);
    if (asString(block.type) === "tool_use") {
      const idx = state.nextToolIndex++;
      const id = asString(block.id, newId("call"));
      state.toolIndexById.set(id, idx);
      out.push(
        JSON.stringify({
          ...base(),
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: idx,
                    id,
                    type: "function",
                    function: {
                      name: asString(block.name),
                      arguments: "",
                    },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        }),
      );
    }
    return out;
  }

  if (type === "content_block_delta") {
    const delta = asObject(json.delta);
    const dt = asString(delta.type);
    if (dt === "text_delta" || delta.text) {
      out.push(
        JSON.stringify({
          ...base(),
          choices: [
            {
              index: 0,
              delta: { content: asString(delta.text) },
              finish_reason: null,
            },
          ],
        }),
      );
    } else if (dt === "input_json_delta") {
      // find tool by content_block index — map via last known
      const blockIndex = typeof json.index === "number" ? json.index : 0;
      // prefer matching by insertion order: tool indices are sequential
      const toolIndex =
        [...state.toolIndexById.values()].includes(blockIndex)
          ? blockIndex
          : (state.nextToolIndex > 0 ? state.nextToolIndex - 1 : 0);
      out.push(
        JSON.stringify({
          ...base(),
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: toolIndex,
                    function: {
                      arguments: asString(delta.partial_json),
                    },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        }),
      );
    }
    return out;
  }

  if (type === "message_delta") {
    const delta = asObject(json.delta);
    const stop = asString(delta.stop_reason);
    let finish: string | null = null;
    if (stop === "tool_use") finish = "tool_calls";
    else if (stop === "max_tokens") finish = "length";
    else if (stop === "end_turn" || stop === "stop_sequence") finish = "stop";
    if (finish) {
      state.finishSent = true;
      out.push(
        JSON.stringify({
          ...base(),
          choices: [{ index: 0, delta: {}, finish_reason: finish }],
        }),
      );
    }
    return out;
  }

  if (type === "message_stop") {
    out.push("[DONE]");
    return out;
  }

  return out;
}

function chatSseToAnthropic(json: JsonObject, state: StreamState): string[] {
  const choices = Array.isArray(json.choices) ? (json.choices as unknown[]) : [];
  const choice0 = asObject(choices[0]);

  // Full completion (non-delta) in stream — rare
  if (choice0.message && !choice0.delta) {
    const msg = chatResponseToAnthropic(json);
    return [
      JSON.stringify({
        type: "message_start",
        message: { ...msg, content: [] },
      }),
      ...asContentBlocks(msg),
      JSON.stringify({
        type: "message_delta",
        delta: { stop_reason: asString(msg.stop_reason, "end_turn") },
      }),
      JSON.stringify({ type: "message_stop" }),
    ];
  }

  const choice = choice0;
  const delta = asObject(choice.delta);
  const out: string[] = [];

  if (json.id) state.id = asString(json.id, state.id);
  if (json.model) state.model = asString(json.model, state.model);

  if (delta.role === "assistant" && !delta.content && !delta.tool_calls) {
    out.push(
      JSON.stringify({
        type: "message_start",
        message: {
          id: state.id.replace(/^chatcmpl/, "msg"),
          type: "message",
          role: "assistant",
          model: state.model,
          content: [],
        },
      }),
    );
  }

  if (typeof delta.content === "string" && delta.content) {
    out.push(
      JSON.stringify({
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: delta.content },
      }),
    );
  }

  for (const tc of (Array.isArray(delta.tool_calls) ? delta.tool_calls : []) as unknown[]) {
    const call = asObject(tc);
    const fn = asObject(call.function);
    const idx = typeof call.index === "number" ? call.index : 0;
    if (call.id || fn.name) {
      const id = asString(call.id, newId("toolu"));
      state.toolIndexById.set(String(idx), idx);
      out.push(
        JSON.stringify({
          type: "content_block_start",
          index: idx,
          content_block: {
            type: "tool_use",
            id,
            name: asString(fn.name),
            input: {},
          },
        }),
      );
    }
    if (fn.arguments) {
      out.push(
        JSON.stringify({
          type: "content_block_delta",
          index: idx,
          delta: {
            type: "input_json_delta",
            partial_json: asString(fn.arguments),
          },
        }),
      );
    }
  }

  const finish = choice.finish_reason;
  if (typeof finish === "string" && finish) {
    state.finishSent = true;
    let stop = "end_turn";
    if (finish === "tool_calls") stop = "tool_use";
    else if (finish === "length") stop = "max_tokens";
    out.push(
      JSON.stringify({
        type: "message_delta",
        delta: { stop_reason: stop },
      }),
    );
    out.push(JSON.stringify({ type: "message_stop" }));
    state.doneSent = true;
  }

  return out;
}

function asContentBlocks(msg: JsonObject): string[] {
  const out: string[] = [];
  const content = Array.isArray(msg.content) ? msg.content : [];
  content.forEach((block, index) => {
    if (!isObject(block)) return;
    out.push(
      JSON.stringify({
        type: "content_block_start",
        index,
        content_block: block,
      }),
    );
    if (asString(block.type) === "text") {
      out.push(
        JSON.stringify({
          type: "content_block_delta",
          index,
          delta: { type: "text_delta", text: asString(block.text) },
        }),
      );
    }
    out.push(JSON.stringify({ type: "content_block_stop", index }));
  });
  return out;
}

function responseCallKeys(payload: JsonObject, item: JsonObject): string[] {
  const keys: string[] = [];
  const add = (prefix: string, value: unknown) => {
    if (typeof value === "string" && value) keys.push(`${prefix}:${value}`);
  };
  add("call", payload.call_id);
  add("call", item.call_id);
  add("item", payload.item_id);
  add("item", item.item_id);
  add("item", item.id);
  const outputIndex =
    typeof payload.output_index === "number"
      ? payload.output_index
      : typeof item.output_index === "number"
        ? item.output_index
        : undefined;
  if (outputIndex !== undefined) keys.push(`output:${outputIndex}`);
  return keys;
}

function registerResponseCall(
  state: StreamState,
  payload: JsonObject,
  item: JsonObject = asObject(payload.item),
): ResponsesCallState {
  const keys = responseCallKeys(payload, item);
  let call: ResponsesCallState | undefined;
  for (const key of keys) {
    call = state.responsesCallByKey.get(key);
    if (call) break;
  }

  const itemId = asString(item.id || payload.item_id) || undefined;
  const outputIndex =
    typeof payload.output_index === "number"
      ? payload.output_index
      : typeof item.output_index === "number"
        ? item.output_index
        : undefined;
  const explicitCallId = asString(payload.call_id || item.call_id);
  const callId = explicitCallId || itemId || asString(payload.item_id);

  if (!call) {
    call = {
      index: state.nextToolIndex++,
      callId: callId || newId("call"),
      itemId,
      outputIndex,
      name: asString(item.name || payload.name),
      arguments: "",
      emitted: false,
    };
    state.responsesCalls.push(call);
  } else {
    if (explicitCallId) call.callId = explicitCallId;
    if (itemId) call.itemId = itemId;
    if (outputIndex !== undefined) call.outputIndex = outputIndex;
    const name = asString(item.name || payload.name);
    if (name) call.name = name;
  }

  for (const key of keys) state.responsesCallByKey.set(key, call);
  state.responsesCallByKey.set(`call:${call.callId}`, call);
  if (call.itemId) state.responsesCallByKey.set(`item:${call.itemId}`, call);
  if (call.outputIndex !== undefined) {
    state.responsesCallByKey.set(`output:${call.outputIndex}`, call);
  }
  return call;
}

function responsesFunctionCallItemId(callId: string): string {
  if (callId.startsWith("fc_")) return callId;
  const safe = callId.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 80);
  return `fc_${safe || newId("call")}`;
}

function responsesSseToChat(
  json: JsonObject,
  eventName: string | undefined,
  state: StreamState,
): string[] {
  const type = asString(json.type || eventName);
  const out: string[] = [];
  const base = () => ({
    id: state.id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: state.model || asString(json.model, ""),
  });

  const textDelta = (text: string): void => {
    if (!text) return;
    state.responsesText += text;
    out.push(
      JSON.stringify({
        ...base(),
        choices: [
          {
            index: 0,
            delta: { content: text },
            finish_reason: null,
          },
        ],
      }),
    );
  };

  const argumentDelta = (
    call: ResponsesCallState,
    raw: unknown,
    final: boolean,
  ): void => {
    if (raw === undefined || raw === null) return;
    const next =
      typeof raw === "string" ? raw : stringifyToolArguments(raw);
    if (!next) return;
    let delta = next;
    if (final) {
      if (next === call.arguments || call.arguments.startsWith(next)) return;
      delta = next.startsWith(call.arguments)
        ? next.slice(call.arguments.length)
        : next;
      call.arguments = next;
    } else {
      call.arguments += next;
    }
    if (!delta) return;
    out.push(
      JSON.stringify({
        ...base(),
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: call.index,
                  function: { arguments: delta },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      }),
    );
  };

  const callStart = (call: ResponsesCallState): void => {
    if (call.emitted) return;
    call.emitted = true;
    out.push(
      JSON.stringify({
        ...base(),
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: call.index,
                  id: call.callId,
                  type: "function",
                  function: { name: call.name, arguments: "" },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      }),
    );
  };

  const emitFinalOutput = (payload: JsonObject): void => {
    const response = asObject(payload.response);
    const output = Array.isArray(response.output)
      ? response.output
      : Array.isArray(payload.output)
        ? payload.output
        : [];
    output.forEach((rawItem, outputIndex) => {
      if (!isObject(rawItem)) return;
      const item = rawItem;
      const itemType = asString(item.type);
      if (itemType === "function_call") {
        const call = registerResponseCall(
          state,
          { ...item, output_index: outputIndex },
          item,
        );
        callStart(call);
        argumentDelta(call, item.arguments, true);
      } else if (itemType === "message") {
        for (const part of asArray(item.content)) {
          if (!isObject(part)) continue;
          if (asString(part.type) === "output_text" || asString(part.type) === "text") {
            const text = asString(part.text);
            const delta = text.startsWith(state.responsesText)
              ? text.slice(state.responsesText.length)
              : text;
            textDelta(delta);
          }
        }
      } else if (itemType === "output_text") {
        const text = asString(item.text);
        const delta = text.startsWith(state.responsesText)
          ? text.slice(state.responsesText.length)
          : text;
        textDelta(delta);
      }
    });
  };

  if (type === "response.created" || type === "response.in_progress") {
    const resp = asObject(json.response);
    if (resp.id) state.id = asString(resp.id).replace(/^resp/, "chatcmpl");
    if (resp.model) state.model = asString(resp.model);
    out.push(
      JSON.stringify({
        ...base(),
        choices: [
          {
            index: 0,
            delta: { role: "assistant", content: "" },
            finish_reason: null,
          },
        ],
      }),
    );
    return out;
  }

  if (
    type === "response.output_text.delta" ||
    type === "response.text.delta"
  ) {
    textDelta(asString(json.delta ?? json.text));
    return out;
  }

  if (type === "response.output_item.added" || type === "response.output_item.done") {
    const item = asObject(json.item);
    if (asString(item.type) === "function_call") {
      const call = registerResponseCall(state, json, item);
      callStart(call);
      if (type === "response.output_item.done") {
        argumentDelta(call, item.arguments, true);
      }
    }
    return out;
  }

  if (
    type === "response.function_call_arguments.delta" ||
    type === "response.output_item.delta"
  ) {
    const item = asObject(json.item);
    const call = registerResponseCall(state, json, item);
    callStart(call);
    const delta = asObject(json.delta);
    const deltaArgs =
      typeof json.delta === "string"
        ? json.delta
        : delta.arguments ?? item.arguments;
    argumentDelta(call, deltaArgs, false);
    return out;
  }

  if (type === "response.function_call_arguments.done") {
    const item = asObject(json.item);
    const call = registerResponseCall(state, json, item);
    callStart(call);
    argumentDelta(call, json.arguments ?? item.arguments, true);
    return out;
  }

  if (type === "response.completed" || type === "response.done") {
    emitFinalOutput(json);
    if (!state.finishSent) {
      state.finishSent = true;
      const status = asString(asObject(json.response).status);
      out.push(
        JSON.stringify({
          ...base(),
          choices: [
            {
              index: 0,
              delta: {},
              finish_reason:
                state.responsesCalls.length > 0
                  ? "tool_calls"
                  : status === "incomplete"
                    ? "length"
                    : "stop",
            },
          ],
        }),
      );
    }
    if (!state.doneSent) {
      out.push("[DONE]");
    }
    return out;
  }

  if (Array.isArray(json.output) || Array.isArray(asObject(json.response).output)) {
    emitFinalOutput(json);
  }

  // content part text
  if (type === "response.content_part.delta") {
    const delta = asObject(json.delta);
    const text = asString(delta.text ?? json.delta);
    textDelta(text);
  }

  return out;
}

function chatSseToResponses(json: JsonObject, state: StreamState): string[] {
  const choices = Array.isArray(json.choices) ? (json.choices as unknown[]) : [];
  const choice = asObject(choices[0]);
  const delta = asObject(choice.delta);
  const out: string[] = [];

  if (json.id) state.id = asString(json.id, state.id);
  if (json.model) state.model = asString(json.model, state.model);
  const respId = state.id.replace(/^chatcmpl/, "resp");

  if (delta.role === "assistant") {
    out.push(
      JSON.stringify({
        type: "response.created",
        response: {
          id: respId,
          object: "response",
          status: "in_progress",
          model: state.model,
        },
      }),
    );
  }

  if (typeof delta.content === "string" && delta.content) {
    out.push(
      JSON.stringify({
        type: "response.output_text.delta",
        delta: delta.content,
      }),
    );
  }

  for (const tc of (Array.isArray(delta.tool_calls) ? delta.tool_calls : []) as unknown[]) {
    const call = asObject(tc);
    const fn = asObject(call.function);
    const idx = typeof call.index === "number" ? call.index : 0;
    const callId = asString(call.id, newId("call"));
    const itemId = responsesFunctionCallItemId(callId);
    if (call.id || fn.name) {
      registerResponseCall(
        state,
        { call_id: callId, item_id: itemId, output_index: idx, name: asString(fn.name) },
        { type: "function_call", id: itemId, call_id: callId, name: asString(fn.name) },
      );
      out.push(
        JSON.stringify({
          type: "response.output_item.added",
          item: {
            type: "function_call",
            id: itemId,
            call_id: callId,
            name: asString(fn.name),
            arguments: "",
          },
        }),
      );
    }
    if (fn.arguments) {
      out.push(
        JSON.stringify({
          type: "response.function_call_arguments.delta",
          call_id: asString(call.id),
          item_id: itemId,
          output_index: idx,
          delta: stringifyToolArguments(fn.arguments),
        }),
      );
    }
  }

  const finish = choice.finish_reason;
  if (typeof finish === "string" && finish) {
    if (!state.finishSent) {
      state.finishSent = true;
      out.push(
        JSON.stringify({
          type: "response.completed",
          response: {
            id: respId,
            object: "response",
            status: "completed",
            model: state.model,
          },
        }),
      );
    }
    if (!state.doneSent) {
      out.push("[DONE]");
    }
  }

  return out;
}

function terminalPayloads(state: StreamState, to: Protocol): string[] {
  const out: string[] = [];
  if (!state.finishSent) {
    state.finishSent = true;
    if (to === "chat_completions") {
      out.push(
        JSON.stringify({
          id: state.id,
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model: state.model,
          choices: [
            {
              index: 0,
              delta: {},
              finish_reason: state.responsesCalls.length
                ? "tool_calls"
                : "stop",
            },
          ],
        }),
      );
    } else if (to === "responses") {
      out.push(
        JSON.stringify({
          type: "response.completed",
          response: {
            id: state.id.replace(/^chatcmpl/, "resp"),
            object: "response",
            status: "completed",
            model: state.model,
          },
        }),
      );
    } else if (to === "messages") {
      out.push(
        JSON.stringify({
          type: "message_delta",
          delta: {
            stop_reason: state.responsesCalls.length ? "tool_use" : "end_turn",
          },
        }),
      );
    }
  }
  if (to === "messages") {
    if (!state.doneSent) {
      state.doneSent = true;
      out.push(JSON.stringify({ type: "message_stop" }));
    }
  } else if (!state.doneSent) {
    state.doneSent = true;
    out.push("[DONE]");
  }
  return out;
}

/** Build a protocol-shaped terminal SSE error for a stream that already has headers. */
export function protocolStreamErrorSse(
  protocol: Protocol,
  message: string,
  code = "upstream_error",
): string {
  const error = {
    type: "api_error",
    message,
    code,
  };
  if (protocol === "messages") {
    return (
      encodeSse(JSON.stringify({ type: "error", error }), "error") +
      encodeSse(JSON.stringify({ type: "message_stop" }), "message_stop")
    );
  }
  if (protocol === "responses") {
    return (
      encodeSse(JSON.stringify({ type: "error", error }), "error") +
      encodeSse("[DONE]")
    );
  }
  return encodeSse(JSON.stringify({ error })) + encodeSse("[DONE]");
}

/**
 * Transform an upstream SSE ReadableStream into a client-protocol SSE stream.
 * When from === to, pipes through with optional light normalization.
 */
export function transformSseStream(
  upstream: ReadableStream<Uint8Array>,
  from: Protocol,
  to: Protocol,
): ReadableStream<Uint8Array> {
  if (from === to) return upstream;

  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const state = newState();
  let buffer = "";

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = upstream.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const { events, rest } = parseSseChunk(buffer);
          buffer = rest;
          for (const ev of events) {
            const payloads = convertSseData(
              ev.data,
              ev.event,
              from,
              to,
              state,
            );
            for (const p of payloads) {
              if (p === "[DONE]") {
                if (!state.doneSent) {
                  state.doneSent = true;
                  controller.enqueue(encoder.encode(encodeSse("[DONE]")));
                }
              } else {
                // Anthropic client expects event: lines for messages protocol
                const eventName =
                  to === "messages"
                    ? (safeEventName(p) ?? undefined)
                    : undefined;
                controller.enqueue(
                  encoder.encode(encodeSse(p, eventName)),
                );
              }
            }
          }
        }
        // flush remainder
        if (buffer.trim()) {
          const { events } = parseSseChunk(buffer + "\n\n");
          for (const ev of events) {
            const payloads = convertSseData(
              ev.data,
              ev.event,
              from,
              to,
              state,
            );
            for (const p of payloads) {
              if (p === "[DONE]") {
                if (!state.doneSent) {
                  state.doneSent = true;
                  controller.enqueue(encoder.encode(encodeSse("[DONE]")));
                }
              } else {
                const eventName =
                  to === "messages" ? (safeEventName(p) ?? undefined) : undefined;
                controller.enqueue(encoder.encode(encodeSse(p, eventName)));
              }
            }
          }
        }
        for (const p of terminalPayloads(state, to)) {
          if (p === "[DONE]") {
            controller.enqueue(encoder.encode(encodeSse("[DONE]")));
          } else {
            const eventName =
              to === "messages" ? (safeEventName(p) ?? undefined) : undefined;
            controller.enqueue(encoder.encode(encodeSse(p, eventName)));
          }
        }
        controller.close();
      } catch (err) {
        controller.error(err);
      } finally {
        reader.releaseLock();
      }
    },
  });
}

function safeEventName(payload: string): string | null {
  try {
    const obj = JSON.parse(payload) as { type?: string };
    return typeof obj.type === "string" ? obj.type : null;
  } catch {
    return null;
  }
}

export { stringifyToolArguments };
