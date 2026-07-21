import type { Protocol } from "./types.js";
import {
  asArray,
  asNumber,
  asObject,
  asString,
  deepClone,
  isObject,
  newId,
  type Json,
  type JsonObject,
} from "./types.js";
import { stringifyToolArguments } from "./tools.js";

function usageFromAnthropic(usage: unknown): JsonObject | undefined {
  if (!isObject(usage)) return undefined;
  const prompt = asNumber(usage.input_tokens) ?? 0;
  const completion = asNumber(usage.output_tokens) ?? 0;
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: prompt + completion,
    input_tokens: prompt,
    output_tokens: completion,
  };
}

function usageFromResponses(usage: unknown): JsonObject | undefined {
  if (!isObject(usage)) return undefined;
  const prompt =
    asNumber(usage.input_tokens) ??
    asNumber(usage.prompt_tokens) ??
    0;
  const completion =
    asNumber(usage.output_tokens) ??
    asNumber(usage.completion_tokens) ??
    0;
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens:
      asNumber(usage.total_tokens) ?? prompt + completion,
    input_tokens: prompt,
    output_tokens: completion,
  };
}

function usageToAnthropic(usage: unknown): JsonObject | undefined {
  if (!isObject(usage)) return undefined;
  return {
    input_tokens:
      asNumber(usage.input_tokens) ?? asNumber(usage.prompt_tokens) ?? 0,
    output_tokens:
      asNumber(usage.output_tokens) ?? asNumber(usage.completion_tokens) ?? 0,
  };
}

// ─── anthropic → chat ───────────────────────────────────────────────

export function anthropicResponseToChat(body: JsonObject): JsonObject {
  const content = asArray(body.content);
  const texts: string[] = [];
  const tool_calls: JsonObject[] = [];

  for (const part of content) {
    if (!isObject(part)) continue;
    const type = asString(part.type);
    if (type === "text") {
      texts.push(asString(part.text));
    } else if (type === "tool_use") {
      tool_calls.push({
        id: asString(part.id, newId("call")),
        type: "function",
        function: {
          name: asString(part.name),
          arguments: stringifyToolArguments(part.input),
        },
      });
    }
  }

  const stop = asString(body.stop_reason);
  let finish_reason = "stop";
  if (stop === "tool_use") finish_reason = "tool_calls";
  else if (stop === "max_tokens") finish_reason = "length";
  else if (stop === "end_turn" || stop === "stop_sequence") finish_reason = "stop";

  const message: JsonObject = {
    role: "assistant",
    content: texts.join("") || (tool_calls.length ? null : ""),
  };
  if (tool_calls.length) message.tool_calls = tool_calls;

  return {
    id: asString(body.id, newId("chatcmpl")),
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: body.model ?? "",
    choices: [
      {
        index: 0,
        message,
        finish_reason,
        logprobs: null,
      },
    ],
    usage: usageFromAnthropic(body.usage) ?? {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
    },
  };
}

// ─── chat → anthropic ───────────────────────────────────────────────

export function chatResponseToAnthropic(body: JsonObject): JsonObject {
  const choice = asObject(asArray(body.choices)[0]);
  const message = asObject(choice.message ?? choice.delta);
  const blocks: Json[] = [];
  const text = message.content;
  if (typeof text === "string" && text) {
    blocks.push({ type: "text", text });
  }
  for (const tc of asArray(message.tool_calls)) {
    const call = asObject(tc);
    const fn = asObject(call.function);
    let input: Json = {};
    try {
      input = JSON.parse(asString(fn.arguments, "{}")) as Json;
    } catch {
      input = { raw: asString(fn.arguments) };
    }
    blocks.push({
      type: "tool_use",
      id: asString(call.id, newId("toolu")),
      name: asString(fn.name),
      input,
    });
  }

  const finish = asString(choice.finish_reason);
  let stop_reason = "end_turn";
  if (finish === "tool_calls") stop_reason = "tool_use";
  else if (finish === "length") stop_reason = "max_tokens";

  return {
    id: asString(body.id, newId("msg")),
    type: "message",
    role: "assistant",
    model: body.model ?? "",
    content: blocks,
    stop_reason,
    stop_sequence: null,
    usage: usageToAnthropic(body.usage) ?? {
      input_tokens: 0,
      output_tokens: 0,
    },
  };
}

// ─── responses → chat ───────────────────────────────────────────────

export function responsesResponseToChat(body: JsonObject): JsonObject {
  // Some gateways wrap as { response: {...} }
  const root = isObject(body.response) ? asObject(body.response) : body;
  const output = asArray(root.output);
  const texts: string[] = [];
  const tool_calls: JsonObject[] = [];

  for (const item of output) {
    if (!isObject(item)) continue;
    const type = asString(item.type);
    if (type === "message") {
      for (const part of asArray(item.content)) {
        if (!isObject(part)) continue;
        const pt = asString(part.type);
        if (pt === "output_text" || pt === "text") {
          texts.push(asString(part.text));
        }
      }
    } else if (type === "function_call") {
      tool_calls.push({
        id: asString(item.call_id || item.id, newId("call")),
        type: "function",
        function: {
          name: asString(item.name),
          arguments: stringifyToolArguments(item.arguments),
        },
      });
    } else if (type === "output_text") {
      texts.push(asString(item.text));
    }
  }

  let finish_reason = "stop";
  if (tool_calls.length) finish_reason = "tool_calls";
  if (asString(root.status) === "incomplete" && tool_calls.length) {
    finish_reason = "tool_calls";
  }

  const message: JsonObject = {
    role: "assistant",
    content: texts.join("") || (tool_calls.length ? null : ""),
  };
  if (tool_calls.length) message.tool_calls = tool_calls;

  return {
    id: asString(root.id, newId("chatcmpl")),
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: root.model ?? body.model ?? "",
    choices: [
      {
        index: 0,
        message,
        finish_reason,
        logprobs: null,
      },
    ],
    usage: usageFromResponses(root.usage ?? body.usage) ?? {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
    },
  };
}

// ─── chat → responses ───────────────────────────────────────────────

export function chatResponseToResponses(body: JsonObject): JsonObject {
  const choice = asObject(asArray(body.choices)[0]);
  const message = asObject(choice.message);
  const output: Json[] = [];
  const text = message.content;
  if (typeof text === "string" && text) {
    output.push({
      type: "message",
      id: newId("msg"),
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text }],
    });
  }
  for (const tc of asArray(message.tool_calls)) {
    const call = asObject(tc);
    const fn = asObject(call.function);
    const id = asString(call.id, newId("call"));
    output.push({
      type: "function_call",
      id,
      call_id: id,
      name: asString(fn.name),
      arguments: asString(fn.arguments, "{}"),
      status: "completed",
    });
  }

  const finish = asString(choice.finish_reason);
  return {
    id: asString(body.id, newId("resp")).replace(/^chatcmpl/, "resp"),
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status: "completed",
    model: body.model ?? "",
    output,
    usage: usageFromResponses(body.usage) ?? {
      input_tokens: 0,
      output_tokens: 0,
      total_tokens: 0,
    },
    // helpful for clients
    finish_reason: finish,
  };
}

// ─── responses ↔ anthropic ──────────────────────────────────────────

export function responsesResponseToAnthropic(body: JsonObject): JsonObject {
  return chatResponseToAnthropic(responsesResponseToChat(body));
}

export function anthropicResponseToResponses(body: JsonObject): JsonObject {
  return chatResponseToResponses(anthropicResponseToChat(body));
}

// ─── public entry ───────────────────────────────────────────────────

export function convertResponse(
  body: JsonObject,
  from: Protocol,
  to: Protocol,
): JsonObject {
  if (from === to) return deepClone(body);

  // Errors: best-effort wrap
  if (body.error && !body.choices && !body.content && !body.output) {
    return deepClone(body);
  }

  if (from === "messages" && to === "chat_completions") {
    return anthropicResponseToChat(body);
  }
  if (from === "chat_completions" && to === "messages") {
    return chatResponseToAnthropic(body);
  }
  if (from === "responses" && to === "chat_completions") {
    return responsesResponseToChat(body);
  }
  if (from === "chat_completions" && to === "responses") {
    return chatResponseToResponses(body);
  }
  if (from === "responses" && to === "messages") {
    return responsesResponseToAnthropic(body);
  }
  if (from === "messages" && to === "responses") {
    return anthropicResponseToResponses(body);
  }
  return deepClone(body);
}
