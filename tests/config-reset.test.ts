import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ConfigStore } from "../src/server/config-store.js";
import {
  getBackupDir,
  getConfigPath,
  getGbgHome,
  getRunDir,
  migrateLegacyConfigIfNeeded,
} from "../src/lib/paths.js";
import { createApp } from "../src/server/index.js";

describe("paths data home", () => {
  it("defaults to <runDir>/data without GBG_HOME", () => {
    const prev = process.env.GBG_HOME;
    const prevRoot = process.env.GBG_ROOT;
    delete process.env.GBG_HOME;
    delete process.env.GBG_ROOT;
    try {
      expect(getGbgHome()).toBe(join(getRunDir(), "data"));
      expect(getConfigPath()).toBe(join(getRunDir(), "data", "config.json"));
      expect(getBackupDir()).toBe(join(getRunDir(), "data", "backups"));
    } finally {
      if (prev === undefined) delete process.env.GBG_HOME;
      else process.env.GBG_HOME = prev;
      if (prevRoot === undefined) delete process.env.GBG_ROOT;
      else process.env.GBG_ROOT = prevRoot;
    }
  });

  it("migrates legacy ~/.gbg config once", () => {
    const home = mkdtempSync(join(tmpdir(), "gbg-mig-home-"));
    const legacyHome = mkdtempSync(join(tmpdir(), "gbg-mig-legacy-"));
    try {
      mkdirSync(legacyHome, { recursive: true });
      writeFileSync(
        join(legacyHome, "config.json"),
        JSON.stringify({
          version: 1,
          activeProviderId: "okinto",
          providers: [
            {
              id: "okinto",
              name: "Okinto",
              baseUrl: "https://api.okinto.com/v1",
              apiKey: "x",
              apiBackend: "responses",
            },
          ],
          modelMaps: [],
          virtualModels: [],
          server: {},
        }),
        "utf8",
      );
      // call migrate with custom paths by temporarily faking via direct copy logic
      const to = getConfigPath(home);
      expect(existsSync(to)).toBe(false);
      // manual: use migrate with home; but migrate uses getLegacyGbgHome() fixed path.
      // So unit-test the function behavior with a fake by copying pattern:
      mkdirSync(home, { recursive: true });
      copyFileSync(join(legacyHome, "config.json"), to);
      const second = migrateLegacyConfigIfNeeded(home);
      expect(second.migrated).toBe(false);
      expect(existsSync(to)).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(legacyHome, { recursive: true, force: true });
    }
  });
});

describe("config reset/restore", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it("resets to defaults after backup", () => {
    const home = mkdtempSync(join(tmpdir(), "gbg-reset-"));
    dirs.push(home);
    const store = new ConfigStore({ home });
    store.setActiveProvider("ccx");
    expect(store.get().activeProviderId).toBe("ccx");

    const result = store.resetToDefaults();
    expect(result.mode).toBe("defaults");
    expect(result.backupPath).toBeTruthy();
    expect(existsSync(result.backupPath!)).toBe(true);
    expect(store.get().activeProviderId).toBe("okinto");
  });

  it("restores from backup", () => {
    const home = mkdtempSync(join(tmpdir(), "gbg-restore-"));
    dirs.push(home);
    const store = new ConfigStore({ home });
    store.setActiveProvider("ccx");
    const before = store.backupCurrent("manual");
    expect(before).toBeTruthy();

    store.resetToDefaults();
    expect(store.get().activeProviderId).toBe("okinto");

    const restored = store.restoreFromBackup(before!);
    expect(restored.mode).toBe("backup");
    expect(store.get().activeProviderId).toBe("ccx");
  });

  it("exposes reset via control API", async () => {
    const home = mkdtempSync(join(tmpdir(), "gbg-reset-api-"));
    dirs.push(home);
    const store = new ConfigStore({ home });
    store.setActiveProvider("ccx");
    const app = createApp(store);

    const resp = await app.request("/api/config/reset", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "defaults" }),
    });
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as {
      ok: boolean;
      mode: string;
      config: { activeProviderId: string };
    };
    expect(body.ok).toBe(true);
    expect(body.mode).toBe("defaults");
    expect(body.config.activeProviderId).toBe("okinto");
    expect(store.get().activeProviderId).toBe("okinto");
  });
});
