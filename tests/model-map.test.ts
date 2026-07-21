import { describe, expect, it } from "vitest";
import {
  findModelMap,
  getActiveProvider,
  removeModelMap,
  resolveRoute,
  upsertModelMap,
} from "../src/lib/model-map.js";
import { createDefaultConfig } from "../src/server/types.js";

describe("model-map", () => {
  it("finds and upserts maps by from key", () => {
    let maps = [
      { from: "a", to: "x", providerId: null },
      { from: "b", to: "y", providerId: null },
    ];
    expect(findModelMap(maps, "a")?.to).toBe("x");
    maps = upsertModelMap(maps, { from: "a", to: "z", providerId: "ccx" });
    expect(findModelMap(maps, "a")).toEqual({
      from: "a",
      to: "z",
      providerId: "ccx",
    });
    maps = removeModelMap(maps, "b");
    expect(maps).toHaveLength(1);
  });

  it("resolves active provider and remaps model", () => {
    const cfg = createDefaultConfig();
    cfg.activeProviderId = "okinto";
    const route = resolveRoute(cfg, "grok-build");
    expect(route.mapped).toBe(true);
    expect(route.modelOut).toBe("grok-4.5");
    expect(route.provider.id).toBe("okinto");
  });

  it("pins provider on map when set", () => {
    const cfg = createDefaultConfig();
    cfg.activeProviderId = "okinto";
    cfg.modelMaps = [
      { from: "grok-4.5", to: "claude-x", providerId: "ccx" },
    ];
    const route = resolveRoute(cfg, "grok-4.5");
    expect(route.provider.id).toBe("ccx");
    expect(route.modelOut).toBe("claude-x");
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
      { from: "m", to: "n", providerId: "does-not-exist" },
    ];
    expect(() => resolveRoute(cfg, "m")).toThrow(/unknown\/disabled/);
  });
});
