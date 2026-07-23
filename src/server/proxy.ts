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
  protocolStreamErrorSse,
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
  const backend = provider.apiBackend ?? "responses";

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

type StreamCompletion = {
  status: number;
  error?: string;
  errorStage?: string;
  streamStarted: boolean;
};

type StreamWrapperOptions = {
  signal: AbortSignal;
  clientSignal?: AbortSignal;
  timeoutMs: number;
  timer: ReturnType<typeof setTimeout>;
  timedOut: () => boolean;
  clientCancelled: () => boolean;
  protocol: ApiBackend;
  status: number;
  initialError?: string;
  onCleanup?: () => void;
  onComplete: (result: StreamCompletion) => void;
};

function streamErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function wrapUpstreamStream(
  source: ReadableStream<Uint8Array>,
  options: StreamWrapperOptions,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let settled = false;
  let streamStarted = false;
  let clientAbortHandler: (() => void) | undefined;
  let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;

  const cleanup = () => {
    clearTimeout(options.timer);
    if (clientAbortHandler && options.clientSignal) {
      options.clientSignal.removeEventListener("abort", clientAbortHandler);
    }
    options.onCleanup?.();
  };

  const complete = (result: StreamCompletion) => {
    if (settled) return;
    settled = true;
    cleanup();
    options.onComplete({ ...result, streamStarted });
  };

  const closeController = (controller: ReadableStreamDefaultController<Uint8Array>) => {
    try {
      controller.close();
    } catch {
      // The client may cancel the stream while the upstream read is settling.
    }
  };

  return new ReadableStream<Uint8Array>({
    start(controller) {
      streamController = controller;
      reader = source.getReader();
      clientAbortHandler = () => {
        if (!options.clientCancelled()) return;
        complete({
          status: 499,
          error: "Client cancelled the request",
          errorStage: "client",
          streamStarted,
        });
        const cancellation = reader?.cancel("client_cancelled");
        if (cancellation) void cancellation.catch(() => undefined);
        try {
          if (streamController) closeController(streamController);
        } catch {
          // The runtime may already have canceled the response body.
        }
      };
      if (options.clientSignal) {
        options.clientSignal.addEventListener("abort", clientAbortHandler, {
          once: true,
        });
      }
    },
    async pull(controller) {
      if (!reader || settled) return;
      try {
        const result = await reader.read();
        if (result.done) {
          complete({
            status: options.status,
            error: options.initialError,
            errorStage: options.initialError ? "upstream_http" : undefined,
            streamStarted,
          });
          closeController(controller);
          return;
        }
        if (result.value.byteLength > 0) streamStarted = true;
        controller.enqueue(result.value);
      } catch (err) {
        if (options.clientCancelled()) {
          complete({
            status: 499,
            error: "Client cancelled the request",
            errorStage: "client",
            streamStarted,
          });
          closeController(controller);
          return;
        }
        const timedOut = options.timedOut();
        const message = timedOut
          ? `Upstream stream timed out after ${options.timeoutMs}ms`
          : `Upstream connection closed while reading the stream: ${streamErrorMessage(err)}`;
        // The gateway is about to emit a protocol error event, so the client
        // has a stream response even when upstream sent no body bytes.
        streamStarted = true;
        complete({
          status: timedOut ? 504 : 502,
          error: message,
          errorStage: "upstream_body",
          streamStarted,
        });
        controller.enqueue(
          encoder.encode(
            protocolStreamErrorSse(
              options.protocol,
              message,
              timedOut ? "upstream_timeout" : "upstream_stream_error",
            ),
          ),
        );
        closeController(controller);
      }
    },
    cancel(reason) {
      const cancellation = reader?.cancel(reason);
      if (cancellation) void cancellation.catch(() => undefined);
      complete({
        status: 499,
        error: "Client cancelled the request",
        errorStage: "client",
        streamStarted,
      });
    },
  });
}

function gatewayErrorSummary(
  stage: string,
  providerId: string | null,
  protocol: ApiBackend | null,
  proxyMode: "direct" | "env" | undefined,
  message: string,
): string {
  const subject =
    stage === "upstream_body"
      ? "upstream stream failed"
      : stage === "upstream_headers"
        ? "upstream response headers unavailable"
        : stage === "client"
          ? "client cancelled request"
          : "upstream request failed";
  return `${subject} (provider=${providerId ?? "unknown"}, protocol=${protocol ?? "unknown"}, proxy=${proxyMode ?? "unknown"}): ${message}`;
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
    let upstreamProtocol: ApiBackend = "responses";
    let convertedRequest = false;
    let stream = false;
    let requestBodyMs: number | undefined;
    let upstreamHeadersMs: number | undefined;
    let firstByteMs: number | undefined;
    let durationMs: number | undefined;
    let proxyMode: "direct" | "env" | undefined;
    let logWritten = false;

    const recordLog = (
      status: number,
      error?: string,
      extra: Partial<RequestLogEntry> = {},
    ) => {
      if (logWritten) return;
      logWritten = true;
      const elapsed = Date.now() - started;
      const first = firstByteMs ?? elapsed;
      globalRequestLog.add({
        ...logBase,
        ...extra,
        modelIn,
        modelOut,
        status,
        latencyMs: first,
        requestBodyMs,
        upstreamHeadersMs,
        firstByteMs: first,
        durationMs: durationMs ?? elapsed,
        clientProtocol,
        upstreamProtocol,
        proxyMode,
        error: error ?? extra.error,
      });
    };

    try {
      const bodyStarted = Date.now();
      if (method === "POST" || method === "PUT" || method === "PATCH") {
        const json = await readJsonBody(c);
        if (json && typeof json === "object" && json !== null) {
          let obj = asObject(json) as JsonObject;
          modelIn = typeof obj.model === "string" ? obj.model : null;
          const route = resolveRoute(cfg, modelIn);
          provider = route.provider;
          modelOut = route.modelOut;
          upstreamProtocol = provider.apiBackend ?? "responses";

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
          upstreamProtocol = provider.apiBackend ?? "responses";
          bodyText = await c.req.text();
        }
      } else {
        provider = resolveRoute(cfg, null).provider;
        upstreamProtocol = provider.apiBackend ?? "responses";
      }
      requestBodyMs = Date.now() - bodyStarted;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      requestBodyMs = Date.now() - started;
      recordLog(400, message, { providerId: null, errorStage: "request" });
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
    let timedOut = false;
    let clientCancelled = false;
    let streamOwnsLifecycle = false;
    let stage = "upstream_headers";
    const clientSignal = c.req.raw.signal;
    const onClientAbort = () => {
      clientCancelled = true;
      controller.abort("client_cancelled");
    };
    if (clientSignal.aborted) onClientAbort();
    else clientSignal.addEventListener("abort", onClientAbort, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort("upstream_timeout");
    }, timeoutMs);

    try {
      const forceDirect = isProviderProxyShieldOn(cfg.server, provider);
      proxyMode = forceDirect ? "direct" : "env";
      const upstreamStarted = Date.now();
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
      upstreamHeadersMs = Date.now() - upstreamStarted;
      firstByteMs = Date.now() - started;

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
      for (const h of [
        "connection",
        "content-encoding",
        "content-length",
        "keep-alive",
        "transfer-encoding",
      ]) {
        respHeaders.delete(h);
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
        }
        streamOwnsLifecycle = true;
        body = wrapUpstreamStream(body, {
          signal: controller.signal,
          clientSignal,
          timeoutMs,
          timer,
          timedOut: () => timedOut,
          clientCancelled: () => clientCancelled,
          protocol: clientProtocol ?? upstreamProtocol,
          status: upstream.status,
          initialError:
            upstream.status >= 400 ? `upstream ${upstream.status}` : undefined,
          onCleanup: () => clientSignal.removeEventListener("abort", onClientAbort),
          onComplete: (result) => {
            durationMs = Date.now() - started;
            recordLog(result.status, result.error, {
              stream: true,
              streamStarted: result.streamStarted,
              errorStage: result.errorStage,
            });
          },
        });
        return new Response(body, {
          status: upstream.status,
          headers: respHeaders,
        });
      }

      stage = "upstream_body";
      const buf = await upstream.arrayBuffer();
      durationMs = Date.now() - started;
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

      recordLog(
        upstream.status,
        upstream.status >= 400 ? `upstream ${upstream.status}` : undefined,
        { stream: false, errorStage: upstream.status >= 400 ? "upstream_http" : undefined },
      );
      return new Response(outBuf, {
        status: upstream.status,
        headers: respHeaders,
      });
    } catch (err) {
      const aborted = timedOut || (err instanceof Error && err.name === "AbortError");
      const rawMessage = clientCancelled
        ? "client disconnected"
        : timedOut
          ? `timeout after ${timeoutMs}ms`
          : streamErrorMessage(err);
      const errorStage = clientCancelled ? "client" : stage;
      const message = gatewayErrorSummary(
        errorStage,
        provider.id,
        clientProtocol ?? upstreamProtocol,
        proxyMode,
        rawMessage,
      );
      const status = clientCancelled ? 499 : aborted ? 504 : 502;
      durationMs = Date.now() - started;
      recordLog(status, message, {
        errorStage,
        streamStarted: false,
      });
      const errorBody = {
        error: {
          message,
          type: "api_error",
          code: clientCancelled
            ? "client_cancelled"
            : aborted
              ? "upstream_timeout"
              : "upstream_error",
          provider: provider.id,
          clientProtocol,
          upstreamProtocol,
          proxyMode,
          errorStage,
          streamStarted: false as const,
        },
      };
      if (status === 499) {
        return new Response(JSON.stringify(errorBody), {
          status: 499,
          headers: { "content-type": "application/json" },
        });
      }
      return c.json(errorBody, status);
    } finally {
      if (!streamOwnsLifecycle) {
        clearTimeout(timer);
        clientSignal.removeEventListener("abort", onClientAbort);
      }
    }
  }

  return { handleModels, handleProxy, joinUrl };
}

export { joinUrl } from "../lib/url.js";
