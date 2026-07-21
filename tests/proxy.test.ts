import { describe, expect, it } from "vitest";
import { joinUrl } from "../src/server/proxy.js";
import { createApp } from "../src/server/index.js";
import { ConfigStore } from "../src/server/config-store.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach } from "vitest";

describe("joinUrl", () => {
  it("avoids double /v1", () => {
    expect(joinUrl("https://api.example.com/v1", "/v1/chat/completions")).toBe(
      "https://api.example.com/v1/chat/completions",
    );
    expect(joinUrl("https://api.example.com/v1/", "/v1/models")).toBe(
      "https://api.example.com/v1/models",
    );
    expect(joinUrl("https://api.example.com", "/v1/models")).toBe(
      "https://api.example.com/v1/models",
    );
  });
});

describe("proxy app", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it("serves virtual models and health", async () => {
    const home = mkdtempSync(join(tmpdir(), "gbg-proxy-"));
    dirs.push(home);
    const store = new ConfigStore({ home });
    const app = createApp(store);

    const health = await app.request("/api/health");
    expect(health.status).toBe(200);
    const hj = (await health.json()) as { ok: boolean };
    expect(hj.ok).toBe(true);

    const models = await app.request("/v1/models");
    expect(models.status).toBe(200);
    const mj = (await models.json()) as { data: Array<{ id: string }> };
    expect(mj.data.some((m) => m.id === "grok-4.5")).toBe(true);
  });

  it("rewrites model and forwards to mock upstream", async () => {
    const home = mkdtempSync(join(tmpdir(), "gbg-proxy-"));
    dirs.push(home);
    const store = new ConfigStore({ home });

    const received: { url?: string; body?: string; auth?: string | null } = {};
    const { createServer } = await import("node:http");
    const upstream = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        received.url = req.url;
        received.auth = req.headers.authorization ?? null;
        received.body = Buffer.concat(chunks).toString("utf8");
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            id: "chatcmpl-test",
            choices: [{ message: { role: "assistant", content: "hi" } }],
          }),
        );
      });
    });

    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    const addr = upstream.address();
    if (!addr || typeof addr === "string") throw new Error("no addr");
    const port = addr.port;

    store.update((cfg) => {
      cfg.providers = [
        {
          id: "mock",
          name: "Mock",
          baseUrl: `http://127.0.0.1:${port}/v1`,
          apiKey: "test-key-123",
          apiBackend: "chat_completions",
          modelsListUrl: null,
          enabled: true,
          extraHeaders: {},
        },
      ];
      cfg.activeProviderId = "mock";
      cfg.modelMaps = [{ from: "grok-build", to: "upstream-model", providerId: null }];
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
    const body = JSON.parse(received.body || "{}") as { model?: string };
    expect(body.model).toBe("upstream-model");
    expect(received.auth).toBe("Bearer test-key-123");
    expect(received.url).toContain("/chat/completions");

    await new Promise<void>((resolve, reject) =>
      upstream.close((err) => (err ? reject(err) : resolve())),
    );
  });

  it("switches active provider via control API", async () => {
    const home = mkdtempSync(join(tmpdir(), "gbg-proxy-"));
    dirs.push(home);
    const store = new ConfigStore({ home });
    const app = createApp(store);

    const resp = await app.request("/api/active-provider", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "ccx" }),
    });
    expect(resp.status).toBe(200);
    expect(store.get().activeProviderId).toBe("ccx");
  });
});
