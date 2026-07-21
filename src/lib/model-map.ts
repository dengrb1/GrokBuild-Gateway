import type { GbgConfig, ModelMap, Provider, ResolvedRoute } from "../server/types.js";

export function findModelMap(
  maps: ModelMap[],
  modelIn: string | null | undefined,
): ModelMap | undefined {
  if (!modelIn) return undefined;
  return maps.find((m) => m.from === modelIn);
}

export function getProviderById(
  config: GbgConfig,
  id: string,
): Provider | undefined {
  return config.providers.find((p) => p.id === id && p.enabled);
}

export function getActiveProvider(config: GbgConfig): Provider {
  const active = getProviderById(config, config.activeProviderId);
  if (active) return active;

  const fallback = config.providers.find((p) => p.enabled);
  if (!fallback) {
    throw new Error("No enabled providers configured");
  }
  return fallback;
}

/**
 * Resolve which provider and model name to use for an inbound request.
 * - If a map matches `modelIn`, rewrite to `map.to` and optionally pin provider.
 * - Otherwise passthrough model and use active provider.
 */
export function resolveRoute(
  config: GbgConfig,
  modelIn: string | null | undefined,
): ResolvedRoute {
  const map = findModelMap(config.modelMaps, modelIn);

  if (map) {
    let provider: Provider;
    if (map.providerId) {
      const pinned = getProviderById(config, map.providerId);
      if (!pinned) {
        throw new Error(
          `Model map for "${map.from}" pins unknown/disabled provider "${map.providerId}"`,
        );
      }
      provider = pinned;
    } else {
      provider = getActiveProvider(config);
    }
    return {
      provider,
      modelIn: modelIn ?? null,
      modelOut: map.to,
      mapped: true,
    };
  }

  return {
    provider: getActiveProvider(config),
    modelIn: modelIn ?? null,
    modelOut: modelIn ?? null,
    mapped: false,
  };
}

/** Upsert a map entry by `from` key. */
export function upsertModelMap(
  maps: ModelMap[],
  entry: ModelMap,
): ModelMap[] {
  const idx = maps.findIndex((m) => m.from === entry.from);
  if (idx === -1) return [...maps, entry];
  const next = maps.slice();
  next[idx] = entry;
  return next;
}

export function removeModelMap(maps: ModelMap[], from: string): ModelMap[] {
  return maps.filter((m) => m.from !== from);
}
