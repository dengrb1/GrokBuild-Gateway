import type {
  GbgConfig,
  ModelMap,
  Provider,
  ResolvedRoute,
  RouteCandidate,
} from "../server/types.js";
import { normalizeModelMap } from "../server/types.js";
import { isProviderCoolingDown } from "./provider-health.js";

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

function resolveProviderRef(
  config: GbgConfig,
  providerId: string | null | undefined,
  mapFrom?: string,
): { provider: Provider; fromActive: boolean } {
  const id = providerId?.trim() || "";
  if (!id) {
    return { provider: getActiveProvider(config), fromActive: true };
  }
  const pinned = getProviderById(config, id);
  if (!pinned) {
    throw new Error(
      mapFrom
        ? `Model map for "${mapFrom}" pins unknown/disabled provider "${id}"`
        : `Unknown/disabled provider "${id}"`,
    );
  }
  return { provider: pinned, fromActive: false };
}

function buildCandidates(
  config: GbgConfig,
  map: ModelMap,
  skipCooldown: boolean,
): { candidates: RouteCandidate[]; errors: string[] } {
  const normalized = normalizeModelMap(map);
  const candidates: RouteCandidate[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();

  for (const c of normalized.candidates) {
    if (c.enabled === false) continue;
    let provider: Provider;
    let fromActive = false;
    try {
      const resolved = resolveProviderRef(config, c.providerId, map.from);
      provider = resolved.provider;
      fromActive = resolved.fromActive;
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err));
      continue;
    }
    if (!skipCooldown && isProviderCoolingDown(provider.id)) continue;
    const key = `${provider.id}::${c.model}`;
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push({
      provider,
      modelOut: c.model,
      fromActive,
    });
  }

  return { candidates, errors };
}

/**
 * Resolve which provider and model name to use for an inbound request.
 * - If a map matches `modelIn`, rewrite to mapped model(s) and optional pin.
 * - Multi-channel maps expose ordered `candidates`.
 * - Otherwise passthrough model and use active provider.
 */
export function resolveRoute(
  config: GbgConfig,
  modelIn: string | null | undefined,
  options?: { skipCooldown?: boolean },
): ResolvedRoute {
  const map = findModelMap(config.modelMaps, modelIn);

  if (map) {
    let { candidates, errors } = buildCandidates(
      config,
      map,
      options?.skipCooldown === true,
    );

    // If everything is cooling down, fall back so the request can still try.
    if (!candidates.length && options?.skipCooldown !== true) {
      ({ candidates, errors } = buildCandidates(config, map, true));
    }

    if (!candidates.length) {
      throw new Error(
        errors[0] ||
          `Model map for "${map.from}" has no available provider candidates`,
      );
    }

    const primary = candidates[0]!;
    return {
      provider: primary.provider,
      modelIn: modelIn ?? null,
      modelOut: primary.modelOut,
      mapped: true,
      candidates,
    };
  }

  const provider = getActiveProvider(config);
  const candidate: RouteCandidate = {
    provider,
    modelOut: modelIn ?? null,
    fromActive: true,
  };
  return {
    provider,
    modelIn: modelIn ?? null,
    modelOut: modelIn ?? null,
    mapped: false,
    candidates: [candidate],
  };
}

/** Upsert a map entry by `from` key. */
export function upsertModelMap(
  maps: ModelMap[],
  entry: ModelMap,
): ModelMap[] {
  const normalized = normalizeModelMap(entry);
  const idx = maps.findIndex((m) => m.from === normalized.from);
  if (idx === -1) return [...maps, normalized];
  const next = maps.slice();
  next[idx] = normalized;
  return next;
}

export function removeModelMap(maps: ModelMap[], from: string): ModelMap[] {
  return maps.filter((m) => m.from !== from);
}

export { normalizeModelMap };
