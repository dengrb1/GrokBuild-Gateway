import type { Context } from "hono";
import type { ConfigStore } from "./config-store.js";
import { resolveRoute } from "../lib/model-map.js";
import { resolveSecret } from "../lib/secrets.js";
import { globalRequestLog } from "../lib/request-log.js";
import { joinUrl } from "../lib/url.js";
import { upstreamFetch } from "../lib/http-client.js";
import {
  isProviderProxyShieldOn,
  type ApiBackend,
  type Provider,
  type RequestLogEntry,
} from "./types.js";
import {
  convertRequest,
  convertResponse,
  detectClientProtocol,
  isInferencePath,
  protocolPath,
  transformSseStream,
  type JsonObject,
} from "../lib/protocol/index.js";
import { asObject, isObject } from "../lib/protocol/types.js";

function extractBearer(authHeader: string | undefined): string | null {
  if (!authHeader) return null;
  const m = authHeader.match(/^Bearer\s+(.+)$/i);
  return m?.[1]?.trim() ?? null;
}

function checkGatewayAuth(
  c: Context,
  gatewayToken: string | null | undefined,
): Response | null {
  const expected = gatewayToken?.trim();
  if (!expected) return null;
  const got = extractBearer(c.req.header("authorization"));
  if (got === expected) return null;
  return c.json(
    {
      error: {
        message: "Invalid gateway token",
        type: "authentication_error",
        code: "invalid_gateway_token",
      },
    },
    401,
  );
}

function buildUpstreamHeaders(
  provider: Provider,
  inbound: Headers,
  clientProtocol: ApiBackend | null,
): Headers {
  const headers = new Headers();
  const contentType = inbound.get("content-type");
  if (contentType) headers.set("content-type", contentType);
  else headers.set("content-type", "application/json");

  const accept = inbound.get("accept");
  if (accept) headers.set("accept", accept);

  const key = resolveSecret(provider.apiKey);
  const backend = provider.apiBackend ?? "chat_completions";

  // Anthropic Messages API prefers x-api-key (+ version header)
  if (backend === "messages") {
    if (key) {
      headers.set("x-api-key", key);
      // some OpenAI-compatible Anthropic proxies also accept Bearer
      headers.set("authorization", `Bearer ${key}`);
    }
    if (!headerHas(headers, "anthropic-version") && !provider.extraHeaders?.["anthropic-version"]) {
      headers.set("anthropic-version", "2023-06-01");
    }
    // enable tools / computer use betas when client sent them
    const beta = inbound.get("anthropic-beta");
    if (beta) headers.set("anthropic-beta", beta);
  } else if (key) {
    headers.set("authorization", `Bearer ${key}`);
  }

  for (const [k, v] of Object.entries(provider.extraHeaders ?? {})) {
    headers.set(k, v);
  }

  // Ensure Anthropic stream clients get SSE
  if (
    (backend === "messages" || clientProtocol === "messages") &&
    !headers.get("accept")
  ) {
    headers.set("accept", "application/json");
  }

  return headers;
}

function headerHas(headers: Headers, name: string): boolean {
  return Boolean(headers.get(name));
}

function newLogId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

async function readJsonBody(c: Context): Promise<unknown | null> {
  try {
    return await c.req.json();
  } catch {
    return null;
  }
}

function wantsStream(body: JsonObject | null, accept: string | undefined): boolean {
  if (body && body.stream === true) return true;
  if (accept?.includes("text/event-stream")) return true;
  return false;
}

export function createProxyHandlers(store: ConfigStore) {
  async function handleModels(c: Context): Promise<Response> {
    const cfg = store.get();
    const authErr = checkGatewayAuth(c, cfg.server.gatewayToken);
    if (authErr) return authErr;

    const started = Date.now();
    const data = cfg.virtualModels.map((m) => ({
      id: m.id,
      object: "model",
      created: Math.floor(Date.now() / 1000),
      owned_by: m.ownedBy ?? "gbg",
      context_window: m.contextWindow,
      name: m.name,
    }));

    globalRequestLog.add({
      id: newLogId(),
      ts: Date.now(),
      method: "GET",
      path: "/v1/models",
      modelIn: null,
      modelOut: null,
      providerId: cfg.activeProviderId,
      status: 200,
      latencyMs: Date.now() - started,
    });

    return c.json({ object: "list", data });
  }

  async function handleProxy(c: Context): Promise<Response> {
    const cfg = store.get();
    const authErr = checkGatewayAuth(c, cfg.server.gatewayToken);
    if (authErr) return authErr;

    const started = Date.now();
    const path = c.req.path;
    const method = c.req.method.toUpperCase();
    const clientProtocol = detectClientProtocol(path);
    const logBase: Omit<RequestLogEntry, "status" | "latencyMs"> = {
      id: newLogId(),
      ts: Date.now(),
      method,
      path,
      modelIn: null,
      modelOut: null,
      providerId: null,
    };

    let bodyText: string | undefined;
    let modelIn: string | null = null;
    let modelOut: string | null = null;
    let provider: Provider;
    let upstreamProtocol: ApiBackend = "chat_completions";
    let convertedRequest = false;
    let stream = false;

    try {
      if (method === "POST" || method === "PUT" || method === "PATCH") {
        const json = await readJsonBody(c);
        if (json && typeof json === "object" && json !== null) {
          let obj = asObject(json) as JsonObject;
          modelIn = typeof obj.model === "string" ? obj.model : null;
          const route = resolveRoute(cfg, modelIn);
          provider = route.provider;
          modelOut = route.modelOut;
          upstreamProtocol = provider.apiBackend ?? "chat_completions";

          if (modelOut !== null && "model" in obj) {
            obj.model = modelOut;
          }

          // Protocol translation for inference endpoints
          if (clientProtocol && clientProtocol !== upstreamProtocol) {
            obj = convertRequest(obj, clientProtocol, upstreamProtocol);
            convertedRequest = true;
          }

          stream = wantsStream(obj, c.req.header("accept"));
          // Ensure stream flag consistent when client asked for SSE via Accept only
          if (stream && obj.stream !== true) {
            obj.stream = true;
          }

          bodyText = JSON.stringify(obj);
        } else {
          provider = resolveRoute(cfg, null).provider;
          upstreamProtocol = provider.apiBackend ?? "chat_completions";
          bodyText = await c.req.text();
        }
      } else {
        provider = resolveRoute(cfg, null).provider;
        upstreamProtocol = provider.apiBackend ?? "chat_completions";
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      globalRequestLog.add({
        ...logBase,
        modelIn,
        modelOut,
        providerId: null,
        status: 400,
        latencyMs: Date.now() - started,
        error: message,
      });
      return c.json(
        {
          error: {
            message,
            type: "invalid_request_error",
            code: "route_error",
          },
        },
        400,
      );
    }

    logBase.modelIn = modelIn;
    logBase.modelOut = modelOut;
    logBase.providerId = provider.id;

    // Rewrite path to match upstream protocol when translating
    let upstreamPath = path;
    if (clientProtocol && isInferencePath(path)) {
      if (clientProtocol !== upstreamProtocol || convertedRequest) {
        upstreamPath = protocolPath(upstreamProtocol);
      }
    }

    const upstreamUrl = joinUrl(provider.baseUrl, upstreamPath);
    const url = new URL(upstreamUrl);
    const inboundUrl = new URL(c.req.url);
    // Don't forward client-only query params that break upstream
    url.search = inboundUrl.search;

    const headers = buildUpstreamHeaders(
      provider,
      c.req.raw.headers,
      clientProtocol,
    );
    const timeoutMs = cfg.server.requestTimeoutMs ?? 600_000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const forceDirect = isProviderProxyShieldOn(cfg.server, provider);
      const upstream = await upstreamFetch(url, {
        method,
        headers,
        body:
          method === "GET" || method === "HEAD"
            ? undefined
            : (bodyText ?? undefined),
        signal: controller.signal,
        forceDirect,
      });

      const respHeaders = new Headers();
      const passHeaders = [
        "content-type",
        "cache-control",
        "x-request-id",
        "openai-processing-ms",
        "openai-version",
        "anthropic-ratelimit-requests-remaining",
        "anthropic-ratelimit-tokens-remaining",
        "request-id",
      ];
      for (const h of passHeaders) {
        const v = upstream.headers.get(h);
        if (v) respHeaders.set(h, v);
      }

      const ct = upstream.headers.get("content-type") ?? "";
      const isStream =
        stream ||
        ct.includes("text/event-stream") ||
        ct.includes("application/x-ndjson");

      const needsResponseConvert =
        Boolean(clientProtocol) &&
        clientProtocol !== upstreamProtocol &&
        upstream.ok;

      if (isStream && upstream.body) {
        let body: ReadableStream<Uint8Array> = upstream.body;
        if (needsResponseConvert && clientProtocol) {
          body = transformSseStream(
            upstream.body,
            upstreamProtocol,
            clientProtocol,
          );
          respHeaders.set("content-type", "text/event-stream; charset=utf-8");
          respHeaders.set("cache-control", "no-cache");
          respHeaders.delete("content-length");
        }
        globalRequestLog.add({
          ...logBase,
          status: upstream.status,
          latencyMs: Date.now() - started,
          stream: true,
          error: upstream.status >= 400 ? `upstream ${upstream.status}` : undefined,
        });
        return new Response(body, {
          status: upstream.status,
          headers: respHeaders,
        });
      }

      const buf = await upstream.arrayBuffer();
      let outBuf: ArrayBuffer | Uint8Array = buf;

      if (
        needsResponseConvert &&
        clientProtocol &&
        ct.includes("json") &&
        buf.byteLength > 0
      ) {
        try {
          const text = new TextDecoder().decode(buf);
          const parsed: unknown = JSON.parse(text);
          if (isObject(parsed)) {
            const converted = convertResponse(
              parsed,
              upstreamProtocol,
              clientProtocol,
            );
            const encoded = new TextEncoder().encode(
              JSON.stringify(converted),
            );
            outBuf = encoded;
            respHeaders.set("content-type", "application/json");
            respHeaders.delete("content-length");
          }
        } catch {
          // leave original body on parse failure
        }
      }

      // Error responses: try to keep JSON shape friendly
      if (
        !upstream.ok &&
        clientProtocol &&
        clientProtocol !== upstreamProtocol &&
        ct.includes("json")
      ) {
        try {
          const text = new TextDecoder().decode(buf);
          const parsed: unknown = JSON.parse(text);
          if (isObject(parsed)) {
            // Normalize anthropic error → openai-ish
            if (parsed.error && isObject(parsed.error)) {
              // already structured
            } else if (parsed.type === "error") {
              const normalized = {
                error: {
                  message: asObject(parsed.error).message ?? parsed.message ?? text,
                  type: asObject(parsed.error).type ?? "api_error",
                  code: "upstream_error",
                  provider: provider.id,
                },
              };
              outBuf = new TextEncoder().encode(JSON.stringify(normalized));
              respHeaders.set("content-type", "application/json");
            }
          }
        } catch {
          // ignore
        }
      }

      globalRequestLog.add({
        ...logBase,
        status: upstream.status,
        latencyMs: Date.now() - started,
        stream: false,
        error:
          upstream.status >= 400 ? `upstream ${upstream.status}` : undefined,
      });
      return new Response(outBuf, {
        status: upstream.status,
        headers: respHeaders,
      });
    } catch (err) {
      const aborted = err instanceof Error && err.name === "AbortError";
      const message = aborted
        ? `Upstream timeout after ${timeoutMs}ms`
        : err instanceof Error
          ? err.message
          : String(err);
      globalRequestLog.add({
        ...logBase,
        status: aborted ? 504 : 502,
        latencyMs: Date.now() - started,
        error: message,
      });
      return c.json(
        {
          error: {
            message,
            type: "api_error",
            code: aborted ? "upstream_timeout" : "upstream_error",
            provider: provider.id,
            clientProtocol,
            upstreamProtocol,
          },
        },
        aborted ? 504 : 502,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  return { handleModels, handleProxy, joinUrl };
}

export { joinUrl } from "../lib/url.js";
