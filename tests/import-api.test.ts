import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ConfigStore } from "../src/server/config-store.js";
import { createApp } from "../src/server/index.js";

describe("import / virtual model edit / apply-grok API", () => {
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

  it("imports upstream models into virtual + maps", async () => {
    const home = mkdtempSync(join(tmpdir(), "gbg-import-"));
    dirs.push(home);

    const upstream = createServer((req, res) => {
      if (req.url?.includes("/models")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            data: [
              { id: "model-a", owned_by: "up", context_window: 128000 },
              { id: "model-b", name: "Model B" },
            ],
          }),
        );
        return;
      }
      res.writeHead(404);
      res.end();
    });
    servers.push(upstream);
    await new Promise<void>((resolve) =>
      upstream.listen(0, "127.0.0.1", resolve),
    );
    const addr = upstream.address();
    if (!addr || typeof addr === "string") throw new Error("no port");

    const store = new ConfigStore({ home });
    store.update((cfg) => {
      cfg.providers = [
        {
          id: "mock",
          name: "Mock",
          baseUrl: `http://127.0.0.1:${addr.port}/v1`,
          apiKey: "sk-test",
          apiBackend: "chat_completions",
          modelsListUrl: null,
          enabled: true,
          extraHeaders: {},
        },
      ];
      cfg.activeProviderId = "mock";
      cfg.virtualModels = [];
      cfg.modelMaps = [];
      return cfg;
    });

    const app = createApp(store);
    const fetchResp = await app.request("/api/fetch-models", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "mock" }),
    });
    expect(fetchResp.status).toBe(200);
    const fetched = (await fetchResp.json()) as {
      ok: boolean;
      models: Array<{ id: string }>;
    };
    expect(fetched.ok).toBe(true);
    expect(fetched.models.map((m) => m.id).sort()).toEqual([
      "model-a",
      "model-b",
    ]);

    const importResp = await app.request("/api/import-models", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "mock",
        mode: "merge",
        target: "both",
      }),
    });
    expect(importResp.status).toBe(200);
    const imported = (await importResp.json()) as {
      ok: boolean;
      imported: number;
    };
    expect(imported.ok).toBe(true);
    expect(imported.imported).toBe(2);
    expect(store.get().virtualModels.map((m) => m.id).sort()).toEqual([
      "model-a",
      "model-b",
    ]);
    expect(store.get().modelMaps.map((m) => m.from).sort()).toEqual([
      "model-a",
      "model-b",
    ]);
  });

  it("edits virtual model via POST", async () => {
    const home = mkdtempSync(join(tmpdir(), "gbg-vm-"));
    dirs.push(home);
    const store = new ConfigStore({ home });
    store.setVirtualModels([
      { id: "old-id", name: "Old", contextWindow: 1000, ownedBy: "gbg" },
    ]);
    store.setModelMaps([
      { from: "old-id", to: "upstream", providerId: null },
    ]);

    const app = createApp(store);
    const resp = await app.request("/api/virtual-models", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        previousId: "old-id",
        id: "new-id",
        name: "New Name",
        contextWindow: 2000,
        ownedBy: "gbg",
      }),
    });
    expect(resp.status).toBe(201);
    const models = store.get().virtualModels;
    expect(models).toHaveLength(1);
    expect(models[0].id).toBe("new-id");
    expect(models[0].name).toBe("New Name");
    expect(store.get().modelMaps[0].from).toBe("new-id");
  });
});
