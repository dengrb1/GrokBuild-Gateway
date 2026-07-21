import type { ApiBackend } from "../../server/types.js";

export type Protocol = ApiBackend;

export type Json =
  | null
  | boolean
  | number
  | string
  | Json[]
  | { [key: string]: Json };

export type JsonObject = { [key: string]: Json };

export function isObject(v: unknown): v is JsonObject {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function asObject(v: unknown): JsonObject {
  return isObject(v) ? v : {};
}

export function asArray(v: unknown): Json[] {
  return Array.isArray(v) ? (v as Json[]) : [];
}

export function asString(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}

export function asNumber(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

export function asBoolean(v: unknown): boolean | undefined {
  return typeof v === "boolean" ? v : undefined;
}

export function deepClone<T>(v: T): T {
  // JSON clone is enough for request/response plain objects and cheaper
  // than structuredClone for large chat payloads.
  return JSON.parse(JSON.stringify(v)) as T;
}

export function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

export function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export function safeJsonStringify(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value ?? {});
  } catch {
    return "{}";
  }
}
