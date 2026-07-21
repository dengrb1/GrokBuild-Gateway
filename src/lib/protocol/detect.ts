import type { Protocol } from "./types.js";

/** Detect client protocol from inbound URL path. */
export function detectClientProtocol(path: string): Protocol | null {
  const p = path.split("?")[0].replace(/\/+$/, "") || "/";
  if (/\/v1\/chat\/completions$/i.test(p) || /\/chat\/completions$/i.test(p)) {
    return "chat_completions";
  }
  if (/\/v1\/responses$/i.test(p) || /\/responses$/i.test(p)) {
    return "responses";
  }
  if (/\/v1\/messages$/i.test(p) || /\/messages$/i.test(p)) {
    return "messages";
  }
  return null;
}

/** Canonical upstream path for a protocol (joined with provider baseUrl later). */
export function protocolPath(protocol: Protocol): string {
  switch (protocol) {
    case "chat_completions":
      return "/v1/chat/completions";
    case "responses":
      return "/v1/responses";
    case "messages":
      return "/v1/messages";
  }
}

export function isInferencePath(path: string): boolean {
  return detectClientProtocol(path) !== null;
}
