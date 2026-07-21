import {
  asArray,
  asObject,
  asString,
  isObject,
  safeJsonParse,
  safeJsonStringify,
  type Json,
  type JsonObject,
} from "./types.js";

function notNull<T>(x: T | null): x is T {
  return x !== null;
}

/** OpenAI chat tools → Anthropic tools */
export function chatToolsToAnthropic(tools: unknown): JsonObject[] {
  return asArray(tools)
    .map((t): JsonObject | null => {
      const tool = asObject(t);
      const fn = asObject(tool.function ?? tool);
      const name = asString(fn.name || tool.name);
      if (!name) return null;
      const input_schema: Json = isObject(fn.parameters)
        ? fn.parameters
        : isObject(tool.input_schema)
          ? tool.input_schema
          : isObject(fn.input_schema)
            ? fn.input_schema
            : { type: "object", properties: {} };
      return {
        name,
        description: asString(fn.description ?? tool.description),
        input_schema,
      };
    })
    .filter(notNull);
}

/** Anthropic tools → OpenAI chat tools */
export function anthropicToolsToChat(tools: unknown): JsonObject[] {
  return asArray(tools)
    .map((t): JsonObject | null => {
      const tool = asObject(t);
      const name = asString(tool.name);
      if (!name) return null;
      const parameters: Json =
        (tool.input_schema as Json) ??
        (tool.parameters as Json) ??
        ({ type: "object", properties: {} } as Json);
      return {
        type: "function",
        function: {
          name,
          description: asString(tool.description),
          parameters,
        },
      };
    })
    .filter(notNull);
}

/** OpenAI chat tools → Responses tools */
export function chatToolsToResponses(tools: unknown): JsonObject[] {
  return asArray(tools)
    .map((t): JsonObject | null => {
      const tool = asObject(t);
      if (asString(tool.type) && asString(tool.type) !== "function") {
        if (tool.name || tool.type) return tool;
      }
      const fn = asObject(tool.function ?? tool);
      const name = asString(fn.name || tool.name);
      if (!name) return null;
      const parameters: Json = (fn.parameters ??
        tool.parameters ??
        tool.input_schema ?? {
          type: "object",
          properties: {},
        }) as Json;
      return {
        type: "function",
        name,
        description: asString(fn.description ?? tool.description),
        parameters,
      };
    })
    .filter(notNull);
}

/** Responses tools → OpenAI chat tools */
export function responsesToolsToChat(tools: unknown): JsonObject[] {
  return asArray(tools)
    .map((t): JsonObject | null => {
      const tool = asObject(t);
      const type = asString(tool.type, "function");
      if (type !== "function") return null;
      const name = asString(tool.name ?? asObject(tool.function).name);
      if (!name) return null;
      const parameters: Json =
        (tool.parameters as Json) ??
        (asObject(tool.function).parameters as Json) ??
        ({ type: "object", properties: {} } as Json);
      return {
        type: "function",
        function: {
          name,
          description: asString(
            tool.description ?? asObject(tool.function).description,
          ),
          parameters,
        },
      };
    })
    .filter(notNull);
}

/** Responses tools → Anthropic tools */
export function responsesToolsToAnthropic(tools: unknown): JsonObject[] {
  return chatToolsToAnthropic(responsesToolsToChat(tools));
}

/** Anthropic tools → Responses tools */
export function anthropicToolsToResponses(tools: unknown): JsonObject[] {
  return chatToolsToResponses(anthropicToolsToChat(tools));
}

export function chatToolChoiceToAnthropic(choice: unknown): Json | undefined {
  if (choice === undefined || choice === null) return undefined;
  if (choice === "auto") return { type: "auto" };
  if (choice === "none") return { type: "none" };
  if (choice === "required") return { type: "any" };
  if (isObject(choice)) {
    const type = asString(choice.type);
    if (type === "function") {
      const name = asString(asObject(choice.function).name || choice.name);
      if (name) return { type: "tool", name };
    }
    if (type === "tool" && choice.name) return choice;
    if (type === "auto" || type === "any" || type === "none") return choice;
  }
  return { type: "auto" };
}

export function anthropicToolChoiceToChat(choice: unknown): Json | undefined {
  if (choice === undefined || choice === null) return undefined;
  if (choice === "auto" || choice === "none" || choice === "required") {
    return choice as Json;
  }
  if (isObject(choice)) {
    const type = asString(choice.type);
    if (type === "auto") return "auto";
    if (type === "none") return "none";
    if (type === "any") return "required";
    if (type === "tool" && choice.name) {
      return {
        type: "function",
        function: { name: asString(choice.name) },
      };
    }
  }
  return "auto";
}

export function chatToolChoiceToResponses(choice: unknown): Json | undefined {
  if (choice === undefined || choice === null) return undefined;
  if (choice === "auto" || choice === "none" || choice === "required") {
    return choice as Json;
  }
  if (isObject(choice)) {
    const type = asString(choice.type);
    if (type === "function") {
      const name = asString(asObject(choice.function).name || choice.name);
      if (name) return { type: "function", name };
    }
    if (type === "function" || type === "auto" || type === "none") return choice;
  }
  return "auto";
}

export function responsesToolChoiceToChat(choice: unknown): Json | undefined {
  if (choice === undefined || choice === null) return undefined;
  if (choice === "auto" || choice === "none" || choice === "required") {
    return choice as Json;
  }
  if (isObject(choice)) {
    const type = asString(choice.type);
    if (type === "function" && choice.name) {
      return {
        type: "function",
        function: { name: asString(choice.name) },
      };
    }
  }
  return "auto";
}

export function parseToolArguments(args: unknown): JsonObject {
  if (isObject(args)) return args;
  if (typeof args === "string") {
    const parsed = safeJsonParse(args);
    return isObject(parsed) ? parsed : { raw: args };
  }
  return {};
}

export function stringifyToolArguments(args: unknown): string {
  if (typeof args === "string") return args;
  return safeJsonStringify(args ?? {});
}

export function toolResultContentToString(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (isObject(part)) {
          if (typeof part.text === "string") return part.text;
          if (typeof part.content === "string") return part.content;
          return safeJsonStringify(part);
        }
        return safeJsonStringify(part);
      })
      .join("\n");
  }
  if (isObject(content)) return safeJsonStringify(content);
  if (content == null) return "";
  return String(content);
}
