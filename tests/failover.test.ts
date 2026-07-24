import { describe, expect, it, afterEach, beforeEach } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/server/index.js";
import { ConfigStore } from "../src/server/config-store.js";
import { normalizeModelMap } from "../src/server/types.js";
import { resetProviderHealth } from "../src/lib/provider-health.js";

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") reject(new Error("no addr"));
      else resolve(addr.port);
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
}

describe("proxy failover", () => {
  const dirs: string[] = [];
  const servers: Server[] = [];

  beforeEach(() => {
    resetProviderHealth();
  });

  afterEach(async () => {
    for (const s of servers.splice(0)) await close(s);
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it("fails over from 502 provider to next candidate before body", async () => {
    const bad = createServer((_req, res) => {
      res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "bad" } }));
    });
    const goodHits: string[] = [];
    const good = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        goodHits.push(Buffer.concat(chunks).toString("utf8"));
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            id: "chatcmpl-ok",
            choices: [{ message: { role: "assistant", content: "ok" } }],
          }),
        );
      });
    });
    servers.push(bad, good);
    const badPort = await listen(bad);
    const goodPort = await listen(good);

    const home = mkdtempSync(join(tmpdir(), "gbg-fo-"));
    dirs.push(home);
    const store = new ConfigStore({ home });
    store.update((cfg) => {
      cfg.providers = [
        {
          id: "bad",
          name: "Bad",
          baseUrl: `http://127.0.0.1:${badPort}/v1`,
          apiKey: "k1",
          apiBackend: "chat_completions",
          modelsListUrl: null,
          enabled: true,
          extraHeaders: {},
          proxyShield: true,
        },
        {
          id: "good",
          name: "Good",
          baseUrl: `http://127.0.0.1:${goodPort}/v1`,
          apiKey: "k2",
          apiBackend: "chat_completions",
          modelsListUrl: null,
          enabled: true,
          extraHeaders: {},
          proxyShield: true,
        },
      ];
      cfg.activeProviderId = "bad";
      cfg.server.failover = {
        enabled: true,
        maxAttempts: 3,
        firstByteTimeoutMs: 5_000,
        cooldownMs: 1_000,
        consecutiveFailures: 2,
      };
      cfg.modelMaps = [
        normalizeModelMap({
          from: "grok-build",
          to: "model-a",
          candidates: [
            { providerId: "bad", model: "model-a", enabled: true },
            { providerId: "good", model: "model-b", enabled: true },
          ],
        }),
      ];
      return cfg;
    });

    const app = createApp(store);
    const resp = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "grok-build",
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    expect(resp.status).toBe(200);
    expect(goodHits).toHaveLength(1);
    const body = JSON.parse(goodHits[0] || "{}") as { model?: string };
    expect(body.model).toBe("model-b");
  });

  it("does not failover on 400", async () => {
    let hits = 0;
    const bad = createServer((_req, res) => {
      hits += 1;
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "bad request" } }));
    });
    const good = createServer((_req, res) => {
      hits += 10;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
    servers.push(bad, good);
    const badPort = await listen(bad);
    const goodPort = await listen(good);

    const home = mkdtempSync(join(tmpdir(), "gbg-fo-"));
    dirs.push(home);
    const store = new ConfigStore({ home });
    store.update((cfg) => {
      cfg.providers = [
        {
          id: "bad",
          name: "Bad",
          baseUrl: `http://127.0.0.1:${badPort}/v1`,
          apiKey: "k1",
          apiBackend: "chat_completions",
          modelsListUrl: null,
          enabled: true,
          extraHeaders: {},
          proxyShield: true,
        },
        {
          id: "good",
          name: "Good",
          baseUrl: `http://127.0.0.1:${goodPort}/v1`,
          apiKey: "k2",
          apiBackend: "chat_completions",
          modelsListUrl: null,
          enabled: true,
          extraHeaders: {},
          proxyShield: true,
        },
      ];
      cfg.activeProviderId = "bad";
      cfg.modelMaps = [
        normalizeModelMap({
          from: "m",
          to: "m",
          candidates: [
            { providerId: "bad", model: "m", enabled: true },
            { providerId: "good", model: "m", enabled: true },
          ],
        }),
      ];
      return cfg;
    });

    const app = createApp(store);
    const resp = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "m",
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    expect(resp.status).toBe(400);
    expect(hits).toBe(1);
  });
});
