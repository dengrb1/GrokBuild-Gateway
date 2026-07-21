import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ConfigStore } from "../src/server/config-store.js";

describe("ConfigStore", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const d of dirs.splice(0)) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  });

  function tempStore(): ConfigStore {
    const home = mkdtempSync(join(tmpdir(), "gbg-test-"));
    dirs.push(home);
    return new ConfigStore({ home });
  }

  it("creates default config on first load", () => {
    const store = tempStore();
    const cfg = store.get();
    expect(cfg.version).toBe(1);
    expect(cfg.providers.length).toBeGreaterThan(0);
    expect(readFileSync(store.path, "utf8")).toContain("okinto");
  });

  it("switches active provider and persists", () => {
    const store = tempStore();
    store.setActiveProvider("ccx");
    expect(store.get().activeProviderId).toBe("ccx");

    const store2 = new ConfigStore({ home: store.gbgHome });
    expect(store2.get().activeProviderId).toBe("ccx");
  });

  it("rejects removing active provider", () => {
    const store = tempStore();
    expect(() => store.removeProvider(store.get().activeProviderId)).toThrow(
      /active provider/,
    );
  });

  it("upserts model maps", () => {
    const store = tempStore();
    store.update((cfg) => {
      cfg.modelMaps = [
        { from: "a", to: "b", providerId: null },
        { from: "c", to: "d", providerId: "ccx" },
      ];
      return cfg;
    });
    expect(store.get().modelMaps).toHaveLength(2);
  });

  it("redacts api keys", () => {
    const store = tempStore();
    store.update((cfg) => {
      cfg.providers[0].apiKey = "sk-1234567890abcdef";
      return cfg;
    });
    const redacted = store.redact();
    expect(redacted.providers[0].apiKey).not.toBe("sk-1234567890abcdef");
    expect(redacted.providers[0].apiKey).toContain("…");
  });
});
