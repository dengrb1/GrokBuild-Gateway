import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ConfigStore } from "../src/server/config-store.js";
import { createApp } from "../src/server/index.js";
import { globalRequestLog } from "../src/lib/request-log.js";

describe("proxy protocol translation", () => {
  const dirs: string[] = [];
  const servers: Array<ReturnType<typeof createServer>> = [];

  afterEach(async () => {
    for (const s of servers.splice(0)) {
      await new Promise<void>((resolve) => s.close(() => resolve()));
    }
    for (const d of dirs.splice(0)) {
      rmSync(d, { recursive: true, force: true });
    }
  });

  async function listen(
    handler: (req: import("node:http").IncomingMessage, body: string) => {
      status?: number;
      headers?: Record<string, string>;
      body: string;
    },
  ): Promise<{ port: number; received: { url?: string; body?: string; headers: Record<string, string | string[] | undefined> } }> {
    const received: {
      url?: string;
      body?: string;
      headers: Record<string, string | string[] | undefined>;
    } = { headers: {} };

    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        received.url = req.url;
        received.body = Buffer.concat(chunks).toString("utf8");
        received.headers = { ...req.headers };
        const out = handler(req, received.body);
        res.writeHead(out.status ?? 200, {
          "content-type": "application/json",
          ...(out.headers ?? {}),
        });
        res.end(out.body);
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address();
    if (!addr || typeof addr === "string") throw new Error("no port");
    return { port: addr.port, received };
  }

  async function listenRaw(
    handler: (req: IncomingMessage, res: ServerResponse) => void,
  ): Promise<number> {
    const server = createServer(handler);
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address();
    if (!addr || typeof addr === "string") throw new Error("no port");
    return addr.port;
  }

  function configureChatProvider(
    store: ConfigStore,
    port: number,
    id: string,
    requestTimeoutMs: number,
  ): void {
    store.update((cfg) => {
      cfg.providers = [
        {
          id,
          name: id,
          baseUrl: `http://127.0.0.1:${port}/v1`,
          apiKey: "sk-test",
          apiBackend: "chat_completions",
          modelsListUrl: null,
          enabled: true,
          extraHeaders: {},
        },
      ];
      cfg.activeProviderId = id;
      cfg.server.requestTimeoutMs = requestTimeoutMs;
      return cfg;
    });
  }

  it("translates chat_completions → anthropic messages with tools", async () => {
    const home = mkdtempSync(join(tmpdir(), "gbg-proto-"));
    dirs.push(home);
    const store = new ConfigStore({ home });

    const { port, received } = await listen((_req, body) => {
      const req = JSON.parse(body) as {
        tools?: Array<{ name: string }>;
        messages?: unknown[];
        max_tokens?: number;
      };
      expect(req.tools?.[0]?.name).toBe("get_weather");
      expect(req.max_tokens).toBe(256);
      return {
        body: JSON.stringify({
          id: "msg_test",
          type: "message",
          role: "assistant",
          model: "claude-test",
          content: [
            {
              type: "tool_use",
              id: "toolu_abc",
              name: "get_weather",
              input: { city: "SF" },
            },
          ],
          stop_reason: "tool_use",
          usage: { input_tokens: 3, output_tokens: 5 },
        }),
      };
    });

    store.update((cfg) => {
      cfg.providers = [
        {
          id: "anthropic-mock",
          name: "Anthropic Mock",
          baseUrl: `http://127.0.0.1:${port}/v1`,
          apiKey: "sk-ant-test",
          apiBackend: "messages",
          modelsListUrl: null,
          enabled: true,
          extraHeaders: { "anthropic-version": "2023-06-01" },
        },
      ];
      cfg.activeProviderId = "anthropic-mock";
      cfg.modelMaps = [{ from: "grok-4.5", to: "claude-test", providerId: null }];
      return cfg;
    });

    const app = createApp(store);
    const resp = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "grok-4.5",
        messages: [{ role: "user", content: "weather?" }],
        tools: [
          {
            type: "function",
            function: {
              name: "get_weather",
              description: "weather",
              parameters: {
                type: "object",
                properties: { city: { type: "string" } },
              },
            },
          },
        ],
        tool_choice: "auto",
        max_completion_tokens: 256,
      }),
    });

    expect(resp.status).toBe(200);
    expect(received.url).toContain("/messages");
    expect(received.headers["x-api-key"] || received.headers["authorization"]).toBeTruthy();
    expect(received.headers["anthropic-version"]).toBe("2023-06-01");

    const upstreamBody = JSON.parse(received.body || "{}") as {
      model?: string;
      tools?: unknown[];
    };
    expect(upstreamBody.model).toBe("claude-test");

    const chat = (await resp.json()) as {
      choices: Array<{
        finish_reason: string;
        message: { tool_calls?: Array<{ function: { name: string } }> };
      }>;
    };
    expect(chat.choices[0].finish_reason).toBe("tool_calls");
    expect(chat.choices[0].message.tool_calls?.[0].function.name).toBe(
      "get_weather",
    );
  });

  it("translates chat_completions → responses with tools", async () => {
    const home = mkdtempSync(join(tmpdir(), "gbg-proto-"));
    dirs.push(home);
    const store = new ConfigStore({ home });

    const { port, received } = await listen((_req, body) => {
      const req = JSON.parse(body) as { input?: Array<Record<string, unknown>>; tools?: unknown[] };
      expect(req.input).toBeTruthy();
      expect(req.tools).toBeTruthy();
      const call = req.input?.find((i) => i.type === "function_call");
      const result = req.input?.find((i) => i.type === "function_call_output");
      expect(call).toMatchObject({
        id: "fc_call_proxy_1",
        call_id: "call_proxy_1",
        name: "get_weather",
        arguments: '{"city":"LA"}',
      });
      expect(result).toMatchObject({
        call_id: "call_proxy_1",
        output: '{"temp":72}',
      });
      return {
        body: JSON.stringify({
          id: "resp_1",
          object: "response",
          model: "gpt-test",
          status: "completed",
          output: [
            {
              type: "function_call",
              id: "fc1",
              call_id: "fc1",
              name: "get_weather",
              arguments: '{"city":"LA"}',
            },
          ],
          usage: { input_tokens: 1, output_tokens: 2 },
        }),
      };
    });

    store.update((cfg) => {
      cfg.providers = [
        {
          id: "oa-resp",
          name: "OA Responses",
          baseUrl: `http://127.0.0.1:${port}/v1`,
          apiKey: "sk-test",
          apiBackend: "responses",
          modelsListUrl: null,
          enabled: true,
          extraHeaders: {},
        },
      ];
      cfg.activeProviderId = "oa-resp";
      return cfg;
    });

    const app = createApp(store);
    const resp = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "grok-4.5",
        messages: [
          { role: "user", content: "weather?" },
          {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call_proxy_1",
                type: "function",
                function: {
                  name: "get_weather",
                  arguments: '{"city":"LA"}',
                },
              },
            ],
          },
          {
            role: "tool",
            tool_call_id: "call_proxy_1",
            content: '{"temp":72}',
          },
          { role: "user", content: "summarize" },
        ],
        tools: [
          {
            type: "function",
            function: {
              name: "get_weather",
              parameters: { type: "object", properties: {} },
              strict: true,
            },
          },
        ],
      }),
    });

    expect(resp.status).toBe(200);
    expect(received.url).toContain("/responses");
    const chat = (await resp.json()) as {
      choices: Array<{ finish_reason: string }>;
    };
    expect(chat.choices[0].finish_reason).toBe("tool_calls");
  });

  it("passthrough same-protocol chat without rewrite", async () => {
    const home = mkdtempSync(join(tmpdir(), "gbg-proto-"));
    dirs.push(home);
    const store = new ConfigStore({ home });

    const { port, received } = await listen((_req, body) => {
      const req = JSON.parse(body) as { messages?: unknown; tools?: unknown };
      expect(req.messages).toBeTruthy();
      expect(req.tools).toBeTruthy();
      return {
        body: JSON.stringify({
          id: "chatcmpl_1",
          object: "chat.completion",
          model: "m",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "hello" },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
      };
    });

    store.update((cfg) => {
      cfg.providers = [
        {
          id: "openai-chat",
          name: "OpenAI Chat",
          baseUrl: `http://127.0.0.1:${port}/v1`,
          apiKey: "sk",
          apiBackend: "chat_completions",
          modelsListUrl: null,
          enabled: true,
          extraHeaders: {},
        },
      ];
      cfg.activeProviderId = "openai-chat";
      return cfg;
    });

    const app = createApp(store);
    const resp = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "grok-4.5",
        messages: [{ role: "user", content: "hi" }],
        tools: [
          {
            type: "function",
            function: { name: "x", parameters: { type: "object" } },
          },
        ],
      }),
    });
    expect(resp.status).toBe(200);
    expect(received.url).toContain("/chat/completions");
    const json = (await resp.json()) as {
      choices: Array<{ message: { content: string } }>;
    };
    expect(json.choices[0].message.content).toBe("hello");
  });

  it("converts an upstream socket close after headers into an SSE error and DONE", async () => {
    const home = mkdtempSync(join(tmpdir(), "gbg-stream-"));
    dirs.push(home);
    const store = new ConfigStore({ home });
    const port = await listenRaw((req, res) => {
      req.resume();
      req.on("end", () => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write('data: {"id":"chatcmpl_stream"}\n\n');
        setTimeout(() => res.destroy(), 10);
      });
    });
    configureChatProvider(store, port, "stream-close", 500);

    const resp = await createApp(store).request("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "m", stream: true, messages: [{ role: "user", content: "hi" }] }),
    });
    const body = await resp.text();
    expect(resp.status).toBe(200);
    expect(body).toContain("upstream_stream_error");
    expect(body).toContain("data: [DONE]");
    const log = globalRequestLog.list(100).find((entry) => entry.providerId === "stream-close");
    expect(log?.stream).toBe(true);
    expect(log?.firstByteMs).toBeTypeOf("number");
    expect(log?.durationMs).toBeGreaterThanOrEqual(log?.firstByteMs ?? 0);
    expect(log?.errorStage).toBe("upstream_body");
  });

  it("returns structured 502 when upstream closes before response headers", async () => {
    const home = mkdtempSync(join(tmpdir(), "gbg-stream-"));
    dirs.push(home);
    const store = new ConfigStore({ home });
    const port = await listenRaw((req, res) => {
      req.resume();
      req.on("end", () => setTimeout(() => res.destroy(), 5));
    });
    configureChatProvider(store, port, "headers-close", 500);

    const resp = await createApp(store).request("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "m", messages: [{ role: "user", content: "hi" }] }),
    });
    const body = (await resp.json()) as { error: { message: string; errorStage?: string } };
    expect(resp.status).toBe(502);
    expect(body.error.message).toContain("upstream response headers unavailable");
    const log = globalRequestLog.list(100).find((entry) => entry.providerId === "headers-close");
    expect(log?.errorStage).toBe("upstream_headers");
    expect(log?.streamStarted).toBe(false);
  });

  it("keeps timeout protection active until a stream finishes", async () => {
    const home = mkdtempSync(join(tmpdir(), "gbg-stream-"));
    dirs.push(home);
    const store = new ConfigStore({ home });
    const port = await listenRaw((req, res) => {
      req.resume();
      req.on("end", () => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write('data: {"id":"chatcmpl_slow"}\n\n');
        setTimeout(() => res.end('data: [DONE]\n\n'), 100);
      });
    });
    configureChatProvider(store, port, "stream-timeout", 25);

    const resp = await createApp(store).request("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "m", stream: true, messages: [{ role: "user", content: "hi" }] }),
    });
    const body = await resp.text();
    expect(resp.status).toBe(200);
    expect(body).toContain("upstream_timeout");
    expect(body).toContain("data: [DONE]");
    const log = globalRequestLog.list(100).find((entry) => entry.providerId === "stream-timeout");
    expect(log?.status).toBe(504);
    expect(log?.errorStage).toBe("upstream_body");
  });

  it("aborts the upstream stream and records a client cancellation", async () => {
    const home = mkdtempSync(join(tmpdir(), "gbg-stream-"));
    dirs.push(home);
    const store = new ConfigStore({ home });
    const port = await listenRaw((req, res) => {
      req.resume();
      req.on("end", () => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write('data: {"id":"chatcmpl_cancel"}\n\n');
      });
    });
    configureChatProvider(store, port, "stream-cancel", 500);
    const abort = new AbortController();
    const resp = await createApp(store).request("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "m", stream: true, messages: [{ role: "user", content: "hi" }] }),
      signal: abort.signal,
    });
    const reader = resp.body?.getReader();
    await reader?.read();
    abort.abort();
    await reader?.cancel();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const log = globalRequestLog.list(100).find((entry) => entry.providerId === "stream-cancel");
    expect(log?.status).toBe(499);
    expect(log?.errorStage).toBe("client");
    expect(log?.streamStarted).toBe(true);
  });
});
