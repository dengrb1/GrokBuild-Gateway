import { describe, expect, it, beforeEach } from "vitest";
import {
  findModelMap,
  getActiveProvider,
  normalizeModelMap,
  removeModelMap,
  resolveRoute,
  upsertModelMap,
} from "../src/lib/model-map.js";
import {
  markProviderFailure,
  resetProviderHealth,
} from "../src/lib/provider-health.js";
import { createDefaultConfig } from "../src/server/types.js";

describe("model-map", () => {
  beforeEach(() => {
    resetProviderHealth();
  });

  it("finds and upserts maps by from key", () => {
    let maps = [
      { from: "a", to: "x", providerId: null, candidates: [] },
      { from: "b", to: "y", providerId: null, candidates: [] },
    ];
    expect(findModelMap(maps, "a")?.to).toBe("x");
    maps = upsertModelMap(maps, { from: "a", to: "z", providerId: "ccx", candidates: [] });
    expect(findModelMap(maps, "a")?.to).toBe("z");
    expect(findModelMap(maps, "a")?.providerId).toBe("ccx");
    expect(findModelMap(maps, "a")?.candidates?.[0]?.providerId).toBe("ccx");
    maps = removeModelMap(maps, "b");
    expect(maps).toHaveLength(1);
  });

  it("normalizes legacy maps into a single candidate", () => {
    const m = normalizeModelMap({ from: "g", to: "u", providerId: "okinto" });
    expect(m.candidates).toEqual([
      { providerId: "okinto", model: "u", enabled: true },
    ]);
    expect(m.to).toBe("u");
    expect(m.providerId).toBe("okinto");
  });

  it("resolves active provider and remaps model", () => {
    const cfg = createDefaultConfig();
    cfg.activeProviderId = "okinto";
    const route = resolveRoute(cfg, "grok-build");
    expect(route.mapped).toBe(true);
    expect(route.modelOut).toBe("grok-4.5");
    expect(route.provider.id).toBe("okinto");
    expect(route.candidates).toHaveLength(1);
  });

  it("pins provider on map when set", () => {
    const cfg = createDefaultConfig();
    cfg.activeProviderId = "okinto";
    cfg.modelMaps = [
      normalizeModelMap({ from: "grok-4.5", to: "claude-x", providerId: "ccx" }),
    ];
    const route = resolveRoute(cfg, "grok-4.5");
    expect(route.provider.id).toBe("ccx");
    expect(route.modelOut).toBe("claude-x");
  });

  it("returns ordered multi-channel candidates", () => {
    const cfg = createDefaultConfig();
    cfg.activeProviderId = "okinto";
    cfg.modelMaps = [
      normalizeModelMap({
        from: "grok-4.5",
        to: "m1",
        providerId: "okinto",
        candidates: [
          { providerId: "okinto", model: "m1", enabled: true },
          { providerId: "ccx", model: "m2", enabled: true },
          { providerId: "xai", model: "m3", enabled: false },
        ],
      }),
    ];
    const route = resolveRoute(cfg, "grok-4.5");
    expect(route.candidates.map((c) => c.provider.id)).toEqual(["okinto", "ccx"]);
    expect(route.candidates.map((c) => c.modelOut)).toEqual(["m1", "m2"]);
  });

  it("skips cooling-down candidates then falls back if all cool", () => {
    const cfg = createDefaultConfig();
    cfg.modelMaps = [
      normalizeModelMap({
        from: "grok-4.5",
        to: "m1",
        candidates: [
          { providerId: "okinto", model: "m1", enabled: true },
          { providerId: "ccx", model: "m2", enabled: true },
        ],
      }),
    ];
    markProviderFailure("okinto", "boom", {
      consecutiveFailures: 1,
      cooldownMs: 60_000,
    });
    const route = resolveRoute(cfg, "grok-4.5");
    expect(route.provider.id).toBe("ccx");
    expect(route.candidates[0]?.provider.id).toBe("ccx");
  });

  it("passthrough unknown models", () => {
    const cfg = createDefaultConfig();
    const route = resolveRoute(cfg, "custom-model");
    expect(route.mapped).toBe(false);
    expect(route.modelOut).toBe("custom-model");
    expect(route.provider.id).toBe(getActiveProvider(cfg).id);
  });

  it("throws when pinned provider missing", () => {
    const cfg = createDefaultConfig();
    cfg.modelMaps = [
      normalizeModelMap({ from: "m", to: "n", providerId: "does-not-exist" }),
    ];
    expect(() => resolveRoute(cfg, "m")).toThrow(/unknown\/disabled/);
  });
});
