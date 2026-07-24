import type { Context } from "hono";
import type { ConfigStore } from "./config-store.js";
import { resolveRoute } from "../lib/model-map.js";
import { resolveSecret } from "../lib/secrets.js";
import { globalRequestLog } from "../lib/request-log.js";
import { joinUrl } from "../lib/url.js";
import { upstreamFetch } from "../lib/http-client.js";
import {
  isFailoverableStatus,
  isProviderCoolingDown,
  markProviderFailure,
  markProviderSuccess,
} from "../lib/provider-health.js";
import {
  isProviderProxyShieldOn,
  type ApiBackend,
  type AttemptLog,
  type FailoverConfig,
  type Provider,
  type RequestLogEntry,
  type RouteCandidate,
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

  if (backend === "messages") {
    if (key) {
      headers.set("x-api-key", key);
      headers.set("authorization", `Bearer ${key}`);
    }
    if (
      !headerHas(headers, "anthropic-version") &&
      !provider.extraHeaders?.["anthropic-version"]
    ) {
      headers.set("anthropic-version", "2023-06-01");
    }
    const beta = inbound.get("anthropic-beta");
    if (beta) headers.set("anthropic-beta", beta);
  } else if (key) {
    headers.set("authorization", `Bearer ${key}`);
  }

  for (const [k, v] of Object.entries(provider.extraHeaders ?? {})) {
    headers.set(k, v);
  }

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
      // ignore
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
          // ignore
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

function prepareCandidateBody(
  clientObj: JsonObject | null,
  candidate: RouteCandidate,
  clientProtocol: ApiBackend | null,
  accept: string | undefined,
): { bodyText?: string; upstreamProtocol: ApiBackend; stream: boolean; converted: boolean } {
  const upstreamProtocol = candidate.provider.apiBackend ?? "responses";
  if (!clientObj) {
    return { upstreamProtocol, stream: false, converted: false };
  }
  let obj = { ...clientObj } as JsonObject;
  if (candidate.modelOut !== null) {
    obj.model = candidate.modelOut;
  }
  let converted = false;
  if (clientProtocol && clientProtocol !== upstreamProtocol) {
    obj = convertRequest(obj, clientProtocol, upstreamProtocol);
    converted = true;
  }
  let stream = wantsStream(obj, accept);
  if (stream && obj.stream !== true) {
    obj.stream = true;
  }
  return {
    bodyText: JSON.stringify(obj),
    upstreamProtocol,
    stream,
    converted,
  };
}

function copyPassHeaders(upstream: Response): Headers {
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
  return respHeaders;
}

function getFailoverConfig(server: {
  failover?: Partial<FailoverConfig> | null;
}): FailoverConfig {
  return {
    enabled: server.failover?.enabled !== false,
    maxAttempts: server.failover?.maxAttempts ?? 3,
    firstByteTimeoutMs: server.failover?.firstByteTimeoutMs ?? 30_000,
    cooldownMs: server.failover?.cooldownMs ?? 60_000,
    consecutiveFailures: server.failover?.consecutiveFailures ?? 2,
  };
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
    const failover = getFailoverConfig(cfg.server);
    const requestTimeoutMs = cfg.server.requestTimeoutMs ?? 600_000;
    const firstByteBudget = Math.min(
      requestTimeoutMs,
      failover.firstByteTimeoutMs,
    );

    const logBase: Omit<RequestLogEntry, "status" | "latencyMs"> = {
      id: newLogId(),
      ts: Date.now(),
      method,
      path,
      modelIn: null,
      modelOut: null,
      providerId: null,
    };

    let modelIn: string | null = null;
    let modelOut: string | null = null;
    let provider: Provider | null = null;
    let upstreamProtocol: ApiBackend = "responses";
    let stream = false;
    let requestBodyMs: number | undefined;
    let upstreamHeadersMs: number | undefined;
    let firstByteMs: number | undefined;
    let durationMs: number | undefined;
    let proxyMode: "direct" | "env" | undefined;
    let logWritten = false;
    let attempts: AttemptLog[] = [];
    let clientObj: JsonObject | null = null;
    let rawBodyText: string | undefined;
    let candidates: RouteCandidate[] = [];

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
        providerId: provider?.id ?? logBase.providerId,
        status,
        latencyMs: first,
        requestBodyMs,
        upstreamHeadersMs,
        firstByteMs: first,
        durationMs: durationMs ?? elapsed,
        clientProtocol,
        upstreamProtocol,
        proxyMode,
        attempts: attempts.length ? attempts : extra.attempts,
        error: error ?? extra.error,
      });
    };

    try {
      const bodyStarted = Date.now();
      if (method === "POST" || method === "PUT" || method === "PATCH") {
        const json = await readJsonBody(c);
        if (json && typeof json === "object" && json !== null) {
          clientObj = asObject(json) as JsonObject;
          modelIn = typeof clientObj.model === "string" ? clientObj.model : null;
          const route = resolveRoute(cfg, modelIn);
          candidates = route.candidates;
          provider = route.provider;
          modelOut = route.modelOut;
          upstreamProtocol = provider.apiBackend ?? "responses";
          stream = wantsStream(clientObj, c.req.header("accept"));
        } else {
          rawBodyText = await c.req.text();
          const route = resolveRoute(cfg, null);
          candidates = route.candidates;
          provider = route.provider;
          modelOut = route.modelOut;
          upstreamProtocol = provider.apiBackend ?? "responses";
        }
      } else {
        const route = resolveRoute(cfg, null);
        candidates = route.candidates;
        provider = route.provider;
        modelOut = route.modelOut;
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

    if (!provider || !candidates.length) {
      recordLog(400, "No route candidates", { errorStage: "request" });
      return c.json(
        {
          error: {
            message: "No route candidates",
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

    const maxAttempts = failover.enabled
      ? Math.min(failover.maxAttempts, candidates.length)
      : 1;

    const clientSignal = c.req.raw.signal;
    let clientCancelled = false;
    const onClientAbort = () => {
      clientCancelled = true;
    };
    if (clientSignal.aborted) onClientAbort();
    else clientSignal.addEventListener("abort", onClientAbort, { once: true });

    let lastErrorMessage = "All upstream candidates failed";
    let lastStatus = 502;
    let lastProxyMode: "direct" | "env" | undefined;
    let lastUpstreamProtocol: ApiBackend = upstreamProtocol;

    try {
      for (let i = 0; i < maxAttempts; i++) {
        if (clientCancelled) {
          lastStatus = 499;
          lastErrorMessage = "client disconnected";
          break;
        }

        const candidate = candidates[i]!;
        provider = candidate.provider;
        modelOut = candidate.modelOut;
        logBase.providerId = provider.id;
        logBase.modelOut = modelOut;

        if (i > 0 && isProviderCoolingDown(provider.id)) {
          attempts.push({
            providerId: provider.id,
            modelOut,
            skipped: true,
            reason: "cooldown",
          });
          continue;
        }

        const prepared = prepareCandidateBody(
          clientObj,
          candidate,
          clientProtocol,
          c.req.header("accept"),
        );
        upstreamProtocol = prepared.upstreamProtocol;
        lastUpstreamProtocol = upstreamProtocol;
        stream = prepared.stream || stream;
        const bodyText = clientObj
          ? prepared.bodyText
          : rawBodyText;

        let upstreamPath = path;
        if (clientProtocol && isInferencePath(path)) {
          if (clientProtocol !== upstreamProtocol || prepared.converted) {
            upstreamPath = protocolPath(upstreamProtocol);
          }
        }

        const upstreamUrl = joinUrl(provider.baseUrl, upstreamPath);
        const url = new URL(upstreamUrl);
        const inboundUrl = new URL(c.req.url);
        url.search = inboundUrl.search;

        const headers = buildUpstreamHeaders(
          provider,
          c.req.raw.headers,
          clientProtocol,
        );
        const forceDirect = isProviderProxyShieldOn(cfg.server, provider);
        proxyMode = forceDirect ? "direct" : "env";
        lastProxyMode = proxyMode;

        const attemptTimeoutMs =
          i < maxAttempts - 1 ? firstByteBudget : requestTimeoutMs;
        const controller = new AbortController();
        let timedOut = false;
        let streamOwnsLifecycle = false;
        let stage = "upstream_headers";
        const onAttemptClientAbort = () => {
          clientCancelled = true;
          controller.abort("client_cancelled");
        };
        if (clientSignal.aborted) onAttemptClientAbort();
        else {
          clientSignal.addEventListener("abort", onAttemptClientAbort, {
            once: true,
          });
        }
        const timer = setTimeout(() => {
          timedOut = true;
          controller.abort("upstream_timeout");
        }, attemptTimeoutMs);

        const attemptStarted = Date.now();
        try {
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
          upstreamHeadersMs = Date.now() - attemptStarted;
          firstByteMs = Date.now() - started;

          const canFailover =
            failover.enabled &&
            i < maxAttempts - 1 &&
            isFailoverableStatus(upstream.status);

          if (canFailover) {
            // Drain error body so the socket can close cleanly, then try next.
            try {
              await upstream.arrayBuffer();
            } catch {
              // ignore
            }
            clearTimeout(timer);
            clientSignal.removeEventListener("abort", onAttemptClientAbort);
            const errMsg = `upstream ${upstream.status}`;
            attempts.push({
              providerId: provider.id,
              modelOut,
              status: upstream.status,
              error: errMsg,
              latencyMs: Date.now() - attemptStarted,
            });
            markProviderFailure(provider.id, errMsg, {
              consecutiveFailures: failover.consecutiveFailures,
              cooldownMs: failover.cooldownMs,
            });
            lastStatus = upstream.status;
            lastErrorMessage = errMsg;
            continue;
          }

          // Success path (or non-failoverable HTTP error) — lock this candidate.
          markProviderSuccess(provider.id);
          attempts.push({
            providerId: provider.id,
            modelOut,
            status: upstream.status,
            latencyMs: Date.now() - attemptStarted,
            error:
              upstream.status >= 400 ? `upstream ${upstream.status}` : undefined,
          });

          const respHeaders = copyPassHeaders(upstream);
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
              respHeaders.set(
                "content-type",
                "text/event-stream; charset=utf-8",
              );
              respHeaders.set("cache-control", "no-cache");
            }
            streamOwnsLifecycle = true;
            // Extend timeout for the full stream after first-byte decision.
            clearTimeout(timer);
            const streamTimer = setTimeout(() => {
              timedOut = true;
              controller.abort("upstream_timeout");
            }, requestTimeoutMs);
            body = wrapUpstreamStream(body, {
              signal: controller.signal,
              clientSignal,
              timeoutMs: requestTimeoutMs,
              timer: streamTimer,
              timedOut: () => timedOut,
              clientCancelled: () => clientCancelled,
              protocol: clientProtocol ?? upstreamProtocol,
              status: upstream.status,
              initialError:
                upstream.status >= 400
                  ? `upstream ${upstream.status}`
                  : undefined,
              onCleanup: () =>
                clientSignal.removeEventListener("abort", onAttemptClientAbort),
              onComplete: (result) => {
                durationMs = Date.now() - started;
                recordLog(result.status, result.error, {
                  stream: true,
                  streamStarted: result.streamStarted,
                  errorStage: result.errorStage,
                  attempts,
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
                outBuf = new TextEncoder().encode(JSON.stringify(converted));
                respHeaders.set("content-type", "application/json");
                respHeaders.delete("content-length");
              }
            } catch {
              // leave original body
            }
          }

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
                if (parsed.type === "error") {
                  const normalized = {
                    error: {
                      message:
                        asObject(parsed.error).message ??
                        parsed.message ??
                        text,
                      type: asObject(parsed.error).type ?? "api_error",
                      code: "upstream_error",
                      provider: provider.id,
                    },
                  };
                  outBuf = new TextEncoder().encode(
                    JSON.stringify(normalized),
                  );
                  respHeaders.set("content-type", "application/json");
                }
              }
            } catch {
              // ignore
            }
          }

          clearTimeout(timer);
          clientSignal.removeEventListener("abort", onAttemptClientAbort);
          recordLog(
            upstream.status,
            upstream.status >= 400 ? `upstream ${upstream.status}` : undefined,
            {
              stream: false,
              errorStage:
                upstream.status >= 400 ? "upstream_http" : undefined,
              attempts,
            },
          );
          return new Response(outBuf, {
            status: upstream.status,
            headers: respHeaders,
          });
        } catch (err) {
          clearTimeout(timer);
          clientSignal.removeEventListener("abort", onAttemptClientAbort);

          if (clientCancelled) {
            lastStatus = 499;
            lastErrorMessage = "client disconnected";
            attempts.push({
              providerId: provider.id,
              modelOut,
              status: 499,
              error: lastErrorMessage,
              latencyMs: Date.now() - attemptStarted,
            });
            break;
          }

          const aborted =
            timedOut || (err instanceof Error && err.name === "AbortError");
          const rawMessage = timedOut
            ? `timeout after ${attemptTimeoutMs}ms`
            : streamErrorMessage(err);
          const errMsg = gatewayErrorSummary(
            stage,
            provider.id,
            clientProtocol ?? upstreamProtocol,
            proxyMode,
            rawMessage,
          );
          attempts.push({
            providerId: provider.id,
            modelOut,
            status: aborted ? 504 : 502,
            error: errMsg,
            latencyMs: Date.now() - attemptStarted,
          });
          markProviderFailure(provider.id, errMsg, {
            consecutiveFailures: failover.consecutiveFailures,
            cooldownMs: failover.cooldownMs,
          });
          lastStatus = aborted ? 504 : 502;
          lastErrorMessage = errMsg;

          const canFailover =
            failover.enabled && i < maxAttempts - 1 && !clientCancelled;
          if (canFailover) continue;
          break;
        } finally {
          // stream path owns its timers via wrapUpstreamStream
          void streamOwnsLifecycle;
        }
      }

      durationMs = Date.now() - started;
      proxyMode = lastProxyMode;
      upstreamProtocol = lastUpstreamProtocol;
      const summary =
        attempts.length > 1
          ? `${lastErrorMessage} (after ${attempts.length} attempts)`
          : lastErrorMessage;
      recordLog(lastStatus, summary, {
        errorStage: clientCancelled ? "client" : "upstream_headers",
        streamStarted: false,
        attempts,
      });
      const errorBody = {
        error: {
          message: summary,
          type: "api_error",
          code:
            lastStatus === 499
              ? "client_cancelled"
              : lastStatus === 504
                ? "upstream_timeout"
                : "upstream_error",
          provider: provider?.id,
          clientProtocol,
          upstreamProtocol,
          proxyMode,
          errorStage: clientCancelled ? "client" : "upstream_headers",
          streamStarted: false as const,
          attempts,
        },
      };
      if (lastStatus === 499) {
        return new Response(JSON.stringify(errorBody), {
          status: 499,
          headers: { "content-type": "application/json" },
        });
      }
      return c.json(errorBody, lastStatus as 502 | 504);
    } finally {
      clientSignal.removeEventListener("abort", onClientAbort);
    }
  }

  return { handleModels, handleProxy, joinUrl };
}

export { joinUrl } from "../lib/url.js";
