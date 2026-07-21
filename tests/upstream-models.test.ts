import { describe, expect, it } from "vitest";
import {
  buildIdentityMaps,
  mergeModelMaps,
  mergeVirtualModels,
  upstreamToVirtualModels,
} from "../src/lib/upstream-models.js";
import { applyGrokConfig } from "../src/lib/grok-apply.js";
import { createDefaultConfig } from "../src/server/types.js";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach } from "vitest";

describe("upstream model helpers", () => {
  it("converts and merges virtual models", () => {
    const upstream = [
      { id: "a", name: "A", contextWindow: 100 },
      { id: "b", ownedBy: "x" },
    ];
    const virtual = upstreamToVirtualModels(upstream, { ownedBy: "okinto" });
    expect(virtual).toHaveLength(2);
    expect(virtual[0].name).toBe("A");
    expect(virtual[1].ownedBy).toBe("okinto");

    const merged = mergeVirtualModels(
      [{ id: "a", name: "Old", ownedBy: "gbg", contextWindow: 50 }],
      virtual,
      "merge",
    );
    expect(merged.find((m) => m.id === "a")?.name).toBe("A");
    expect(merged.find((m) => m.id === "a")?.contextWindow).toBe(100);
    expect(merged).toHaveLength(2);

    const replaced = mergeVirtualModels(
      [{ id: "z", name: "Z", ownedBy: "gbg" }],
      virtual,
      "replace",
    );
    expect(replaced.map((m) => m.id).sort()).toEqual(["a", "b"]);
  });

  it("builds and merges identity maps", () => {
    const maps = buildIdentityMaps(
      [{ id: "m1" }, { id: "m2" }],
      { providerId: "ccx" },
    );
    expect(maps).toEqual([
      { from: "m1", to: "m1", providerId: "ccx" },
      { from: "m2", to: "m2", providerId: "ccx" },
    ]);

    const merged = mergeModelMaps(
      [{ from: "m1", to: "old", providerId: null }],
      maps,
      "merge",
    );
    expect(merged.find((m) => m.from === "m1")?.to).toBe("m1");
    expect(merged.find((m) => m.from === "m1")?.providerId).toBe("ccx");
  });
});

describe("applyGrokConfig", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it("patches existing toml and creates backup", () => {
    const dir = mkdtempSync(join(tmpdir(), "gbg-grok-"));
    dirs.push(dir);
    const grokPath = join(dir, "config.toml");
    const backupDir = join(dir, "backups");
    writeFileSync(
      grokPath,
      `[cli]
auto_update = true

[models]
default = "something"

[model."grok-4.5"]
model = "grok-4.5"
base_url = "https://api.okinto.com/v1"
api_key = "old"
`,
      "utf8",
    );

    const cfg = createDefaultConfig();
    cfg.server.port = 8787;
    cfg.server.host = "127.0.0.1";

    const result = applyGrokConfig(cfg, {
      grokConfigPath: grokPath,
      backupDir,
    });

    expect(result.ok).toBe(true);
    expect(result.backupPath).toBeTruthy();
    const text = readFileSync(grokPath, "utf8");
    expect(text).toContain('models_base_url = "http://127.0.0.1:8787/v1"');
    expect(text).toContain('base_url = "http://127.0.0.1:8787/v1"');
    expect(text).toContain("auto_update = true");
    expect(text).toContain('[model."grok-4.5"]');
    expect(readFileSync(result.backupPath!, "utf8")).toContain(
      "api.okinto.com",
    );
  });
});
