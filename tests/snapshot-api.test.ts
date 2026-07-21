import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ConfigStore } from "../src/server/config-store.js";
import { createApp } from "../src/server/index.js";

describe("/api/snapshot", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it("returns payload then 204 when rev unchanged", async () => {
    const home = mkdtempSync(join(tmpdir(), "gbg-snap-"));
    dirs.push(home);
    const store = new ConfigStore({ home });
    const app = createApp(store);

    const first = await app.request("/api/snapshot?logs=0");
    expect(first.status).toBe(200);
    const body = (await first.json()) as {
      rev: number;
      logRev: number;
      health: { ok: boolean };
      config: { activeProviderId: string };
    };
    expect(body.health.ok).toBe(true);
    expect(body.config.activeProviderId).toBeTruthy();

    const second = await app.request(
      `/api/snapshot?rev=${body.rev}&logRev=${body.logRev}&logs=0`,
    );
    expect(second.status).toBe(204);

    store.setActiveProvider(
      store.get().providers.find((p) => p.id !== store.get().activeProviderId)!
        .id,
    );
    const third = await app.request(
      `/api/snapshot?rev=${body.rev}&logRev=${body.logRev}&logs=0`,
    );
    expect(third.status).toBe(200);
  });
});
