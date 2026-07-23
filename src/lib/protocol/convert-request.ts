import type { Protocol } from "./types.js";
import {
  asArray,
  asBoolean,
  asNumber,
  asObject,
  asString,
  deepClone,
  isObject,
  newId,
  type Json,
  type JsonObject,
} from "./types.js";
import {
  anthropicToolChoiceToChat,
  anthropicToolsToChat,
  anthropicToolsToResponses,
  chatToolChoiceToAnthropic,
  chatToolChoiceToResponses,
  chatToolsToAnthropic,
  chatToolsToResponses,
  parseToolArguments,
  responsesToolChoiceToChat,
  responsesToolsToChat,
  stringifyToolArguments,
  toolResultContentToString,
} from "./tools.js";

function maxTokensFromChat(body: JsonObject): number | undefined {
  return (
    asNumber(body.max_tokens) ??
    asNumber(body.max_completion_tokens) ??
    asNumber(body.max_output_tokens)
  );
}

function extractSystemFromChatMessages(messages: Json[]): {
  system?: string;
  messages: JsonObject[];
} {
  const systemParts: string[] = [];
  const rest: JsonObject[] = [];
  for (const m of messages) {
    const msg = asObject(m);
    if (asString(msg.role) === "system") {
      systemParts.push(contentToText(msg.content));
    } else {
      rest.push(msg);
    }
  }
  const system = systemParts.filter(Boolean).join("\n\n") || undefined;
  return { system, messages: rest };
}

function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (isObject(part)) {
          if (typeof part.text === "string") return part.text;
          if (asString(part.type) === "text" && typeof part.text === "string") {
            return part.text;
          }
          if (typeof part.content === "string") return part.content;
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  if (content == null) return "";
  return String(content);
}

function responsesFunctionCallItemId(callId: string): string {
  if (callId.startsWith("fc_")) return callId;
  const safe = callId.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 80);
  return `fc_${safe || newId("call")}`;
}

/** Merge consecutive same-role messages (Anthropic requirement for tool results). */
function mergeAnthropicMessages(messages: JsonObject[]): JsonObject[] {
  const out: JsonObject[] = [];
  for (const msg of messages) {
    const role = asString(msg.role);
    const prev = out[out.length - 1];
    if (prev && asString(prev.role) === role) {
      const prevContent = normalizeAnthropicContent(prev.content);
      const curContent = normalizeAnthropicContent(msg.content);
      prev.content = [...prevContent, ...curContent];
    } else {
      out.push({
        role,
        content: normalizeAnthropicContent(msg.content),
      });
    }
  }
  // Anthropic requires alternating starts with user
  if (out.length && asString(out[0].role) === "assistant") {
    out.unshift({ role: "user", content: [{ type: "text", text: "(continue)" }] });
  }
  return out;
}

function normalizeAnthropicContent(content: unknown): Json[] {
  if (typeof content === "string") {
    return content ? [{ type: "text", text: content }] : [];
  }
  if (Array.isArray(content)) {
    return content.map((part) => {
      if (typeof part === "string") return { type: "text", text: part };
      if (isObject(part)) return part;
      return { type: "text", text: String(part) };
    });
  }
  if (content == null) return [];
  if (isObject(content)) return [content];
  return [{ type: "text", text: String(content) }];
}

// ─── chat → anthropic ───────────────────────────────────────────────

export function chatRequestToAnthropic(body: JsonObject): JsonObject {
  const { system, messages: withoutSystem } = extractSystemFromChatMessages(
    asArray(body.messages),
  );
  const converted: JsonObject[] = [];

  for (const msg of withoutSystem) {
    const role = asString(msg.role);
    if (role === "tool") {
      converted.push({
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: asString(msg.tool_call_id || msg.id),
            content: toolResultContentToString(msg.content),
            is_error: asBoolean(msg.is_error) ?? false,
          },
        ],
      });
      continue;
    }
    if (role === "assistant") {
      const blocks: Json[] = [];
      const text = contentToText(msg.content);
      if (text) blocks.push({ type: "text", text });
      for (const tc of asArray(msg.tool_calls)) {
        const call = asObject(tc);
        const fn = asObject(call.function);
        blocks.push({
          type: "tool_use",
          id: asString(call.id, newId("toolu")),
          name: asString(fn.name || call.name),
          input: parseToolArguments(fn.arguments ?? call.arguments ?? call.input),
        });
      }
      converted.push({ role: "assistant", content: blocks.length ? blocks : "" });
      continue;
    }
    // user / other
    converted.push({
      role: role === "user" ? "user" : "user",
      content: msg.content ?? "",
    });
  }

  const out: JsonObject = {
    model: body.model,
    messages: mergeAnthropicMessages(converted),
    max_tokens: maxTokensFromChat(body) ?? 8192,
  };
  if (system) out.system = system;
  if (body.tools) out.tools = chatToolsToAnthropic(body.tools);
  const tc = chatToolChoiceToAnthropic(body.tool_choice);
  if (tc !== undefined) out.tool_choice = tc;
  if (body.temperature !== undefined) out.temperature = body.temperature;
  if (body.top_p !== undefined) out.top_p = body.top_p;
  if (body.stream !== undefined) out.stream = body.stream;
  if (body.stop !== undefined) out.stop_sequences = Array.isArray(body.stop) ? body.stop : [body.stop];
  if (body.metadata !== undefined) out.metadata = body.metadata;
  // thinking / reasoning passthrough if present
  if (body.thinking !== undefined) out.thinking = body.thinking;
  return out;
}

// ─── anthropic → chat ───────────────────────────────────────────────

export function anthropicRequestToChat(body: JsonObject): JsonObject {
  const messages: JsonObject[] = [];
  if (body.system) {
    messages.push({ role: "system", content: contentToText(body.system) });
  }
  for (const m of asArray(body.messages)) {
    const msg = asObject(m);
    const role = asString(msg.role);
    const content = msg.content;

    if (Array.isArray(content)) {
      const toolResults = content.filter(
        (p) => isObject(p) && asString(p.type) === "tool_result",
      );
      const toolUses = content.filter(
        (p) => isObject(p) && asString(p.type) === "tool_use",
      );
      const texts = content.filter(
        (p) =>
          typeof p === "string" ||
          (isObject(p) && (asString(p.type) === "text" || p.text)),
      );

      if (role === "user" && toolResults.length) {
        for (const tr of toolResults) {
          const block = asObject(tr);
          messages.push({
            role: "tool",
            tool_call_id: asString(block.tool_use_id),
            content: toolResultContentToString(block.content),
          });
        }
        const extraText = texts.map((t) => contentToText(t)).join("\n");
        if (extraText) messages.push({ role: "user", content: extraText });
        continue;
      }

      if (role === "assistant") {
        const text = texts.map((t) => contentToText(t)).join("\n") || null;
        const tool_calls = toolUses.map((tu) => {
          const block = asObject(tu);
          return {
            id: asString(block.id, newId("call")),
            type: "function",
            function: {
              name: asString(block.name),
              arguments: stringifyToolArguments(block.input),
            },
          };
        });
        const assistant: JsonObject = {
          role: "assistant",
          content: text,
        };
        if (tool_calls.length) assistant.tool_calls = tool_calls;
        messages.push(assistant);
        continue;
      }
    }

    messages.push({
      role: role || "user",
      content: contentToText(content),
    });
  }

  const out: JsonObject = {
    model: body.model,
    messages,
  };
  if (body.tools) out.tools = anthropicToolsToChat(body.tools);
  const tc = anthropicToolChoiceToChat(body.tool_choice);
  if (tc !== undefined) out.tool_choice = tc;
  if (body.temperature !== undefined) out.temperature = body.temperature;
  if (body.top_p !== undefined) out.top_p = body.top_p;
  if (body.stream !== undefined) out.stream = body.stream;
  const max = asNumber(body.max_tokens);
  if (max !== undefined) {
    out.max_tokens = max;
    out.max_completion_tokens = max;
  }
  if (body.stop_sequences !== undefined) out.stop = body.stop_sequences;
  return out;
}

// ─── chat → responses ───────────────────────────────────────────────

export function chatRequestToResponses(body: JsonObject): JsonObject {
  const { system, messages: withoutSystem } = extractSystemFromChatMessages(
    asArray(body.messages),
  );
  const input: Json[] = [];

  for (const msg of withoutSystem) {
    const role = asString(msg.role);
    if (role === "tool") {
      input.push({
        type: "function_call_output",
        call_id: asString(msg.tool_call_id || msg.id),
        output: toolResultContentToString(msg.content),
      });
      continue;
    }
    if (role === "assistant") {
      const text = contentToText(msg.content);
      if (text) {
        input.push({
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text }],
        });
      }
      for (const tc of asArray(msg.tool_calls)) {
        const call = asObject(tc);
        const fn = asObject(call.function);
        const callId = asString(call.id, newId("call"));
        input.push({
          type: "function_call",
          id: responsesFunctionCallItemId(callId),
          call_id: callId,
          name: asString(fn.name || call.name),
          arguments: stringifyToolArguments(fn.arguments ?? call.arguments),
        });
      }
      continue;
    }
    input.push({
      type: "message",
      role: role === "user" ? "user" : "user",
      content: contentToText(msg.content),
    });
  }

  const out: JsonObject = {
    model: body.model,
    input,
  };
  if (system) out.instructions = system;
  if (body.tools) out.tools = chatToolsToResponses(body.tools);
  const tc = chatToolChoiceToResponses(body.tool_choice);
  if (tc !== undefined) out.tool_choice = tc;
  if (body.temperature !== undefined) out.temperature = body.temperature;
  if (body.top_p !== undefined) out.top_p = body.top_p;
  if (body.stream !== undefined) out.stream = body.stream;
  const max = maxTokensFromChat(body);
  if (max !== undefined) out.max_output_tokens = max;
  // common reasoning field passthrough
  if (body.reasoning !== undefined) out.reasoning = body.reasoning;
  if (body.reasoning_effort !== undefined) {
    out.reasoning = isObject(out.reasoning)
      ? { ...asObject(out.reasoning), effort: body.reasoning_effort }
      : { effort: body.reasoning_effort };
  }
  return out;
}

// ─── responses → chat ───────────────────────────────────────────────

export function responsesRequestToChat(body: JsonObject): JsonObject {
  const messages: JsonObject[] = [];
  if (body.instructions) {
    messages.push({
      role: "system",
      content: contentToText(body.instructions),
    });
  }

  const input = body.input;
  if (typeof input === "string") {
    messages.push({ role: "user", content: input });
  } else {
    for (const item of asArray(input)) {
      if (typeof item === "string") {
        messages.push({ role: "user", content: item });
        continue;
      }
      const obj = asObject(item);
      const type = asString(obj.type);

      if (type === "function_call_output") {
        messages.push({
          role: "tool",
          tool_call_id: asString(obj.call_id || obj.id),
          content: toolResultContentToString(obj.output ?? obj.content),
        });
        continue;
      }
      if (type === "function_call") {
        messages.push({
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: asString(obj.call_id || obj.id, newId("call")),
              type: "function",
              function: {
                name: asString(obj.name),
                arguments: stringifyToolArguments(obj.arguments),
              },
            },
          ],
        });
        continue;
      }
      if (type === "message" || obj.role) {
        const role = asString(obj.role, "user");
        if (role === "assistant") {
          const tool_calls = asArray(obj.tool_calls);
          messages.push({
            role: "assistant",
            content: contentToText(obj.content),
            ...(tool_calls.length ? { tool_calls } : {}),
          });
        } else {
          messages.push({
            role: role === "system" ? "system" : "user",
            content: contentToText(obj.content),
          });
        }
        continue;
      }
      // fallback
      messages.push({ role: "user", content: contentToText(obj) });
    }
  }

  const out: JsonObject = {
    model: body.model,
    messages,
  };
  if (body.tools) out.tools = responsesToolsToChat(body.tools);
  const tc = responsesToolChoiceToChat(body.tool_choice);
  if (tc !== undefined) out.tool_choice = tc;
  if (body.temperature !== undefined) out.temperature = body.temperature;
  if (body.top_p !== undefined) out.top_p = body.top_p;
  if (body.stream !== undefined) out.stream = body.stream;
  const max = asNumber(body.max_output_tokens) ?? asNumber(body.max_tokens);
  if (max !== undefined) {
    out.max_tokens = max;
    out.max_completion_tokens = max;
  }
  return out;
}

// ─── responses ↔ anthropic ──────────────────────────────────────────

export function responsesRequestToAnthropic(body: JsonObject): JsonObject {
  return chatRequestToAnthropic(responsesRequestToChat(body));
}

export function anthropicRequestToResponses(body: JsonObject): JsonObject {
  const chat = anthropicRequestToChat(body);
  const out = chatRequestToResponses(chat);
  if (body.tools) out.tools = anthropicToolsToResponses(body.tools);
  return out;
}

// ─── public entry ───────────────────────────────────────────────────

export function convertRequest(
  body: JsonObject,
  from: Protocol,
  to: Protocol,
): JsonObject {
  if (from === to) return deepClone(body);

  if (from === "chat_completions" && to === "messages") {
    return chatRequestToAnthropic(body);
  }
  if (from === "chat_completions" && to === "responses") {
    return chatRequestToResponses(body);
  }
  if (from === "messages" && to === "chat_completions") {
    return anthropicRequestToChat(body);
  }
  if (from === "messages" && to === "responses") {
    return anthropicRequestToResponses(body);
  }
  if (from === "responses" && to === "chat_completions") {
    return responsesRequestToChat(body);
  }
  if (from === "responses" && to === "messages") {
    return responsesRequestToAnthropic(body);
  }
  return deepClone(body);
}
