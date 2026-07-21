import type { Provider, ServerConfig, VirtualModel } from "../server/types.js";
import { isProviderProxyShieldOn } from "../server/types.js";
import { upstreamFetch } from "./http-client.js";
import { resolveSecret } from "./secrets.js";
import { joinUrl } from "./url.js";

export interface UpstreamModel {
  id: string;
  name?: string;
  ownedBy?: string;
  contextWindow?: number;
  raw?: Record<string, unknown>;
}

export interface FetchUpstreamResult {
  ok: boolean;
  status: number;
  latencyMs: number;
  modelsUrl: string;
  models: UpstreamModel[];
  error?: string;
  bodyPreview?: string;
}

function pickContextWindow(m: Record<string, unknown>): number | undefined {
  const candidates = [
    m.context_window,
    m.contextWindow,
    m.max_model_len,
    m.max_tokens,
    (m as { meta?: { context_window?: number } }).meta?.context_window,
  ];
  for (const c of candidates) {
    if (typeof c === "number" && Number.isFinite(c) && c > 0) return Math.floor(c);
  }
  return undefined;
}

function parseModelsPayload(json: unknown): UpstreamModel[] {
  const out: UpstreamModel[] = [];
  const seen = new Set<string>();

  const push = (item: unknown) => {
    if (!item || typeof item !== "object") return;
    const m = item as Record<string, unknown>;
    const id =
      (typeof m.id === "string" && m.id) ||
      (typeof m.name === "string" && m.name) ||
      (typeof m.model === "string" && m.model) ||
      "";
    if (!id || seen.has(id)) return;
    seen.add(id);
    out.push({
      id,
      name:
        (typeof m.name === "string" && m.name !== id ? m.name : undefined) ||
        (typeof m.display_name === "string" ? m.display_name : undefined),
      ownedBy: typeof m.owned_by === "string" ? m.owned_by : undefined,
      contextWindow: pickContextWindow(m),
      raw: m,
    });
  };

  if (Array.isArray(json)) {
    for (const item of json) push(item);
    return out;
  }

  if (json && typeof json === "object") {
    const obj = json as Record<string, unknown>;
    if (Array.isArray(obj.data)) {
      for (const item of obj.data) push(item);
      return out;
    }
    if (Array.isArray(obj.models)) {
      for (const item of obj.models) push(item);
      return out;
    }
  }

  return out;
}

export async function fetchUpstreamModels(
  provider: Provider,
  options?: { timeoutMs?: number; server?: Pick<ServerConfig, "proxyShield" | "proxyMode"> },
): Promise<FetchUpstreamResult> {
  const timeoutMs = options?.timeoutMs ?? 20_000;
  const forceDirect = isProviderProxyShieldOn(options?.server, provider);
  const key = resolveSecret(provider.apiKey);
  const modelsUrl =
    provider.modelsListUrl?.trim() ||
    joinUrl(provider.baseUrl, "/v1/models");

  if (!key) {
    return {
      ok: false,
      status: 0,
      latencyMs: 0,
      modelsUrl,
      models: [],
      error: `API key not resolved for provider "${provider.id}" (${provider.apiKey || "empty"})`,
    };
  }

  const headers: Record<string, string> = {
    accept: "application/json",
    ...(provider.extraHeaders ?? {}),
  };

  if (provider.apiBackend === "messages") {
    headers["x-api-key"] = key;
    headers.authorization = `Bearer ${key}`;
    if (!headers["anthropic-version"]) {
      headers["anthropic-version"] = "2023-06-01";
    }
  } else {
    headers.authorization = `Bearer ${key}`;
  }

  const started = Date.now();
  try {
    const resp = await upstreamFetch(modelsUrl, {
      headers,
      signal: AbortSignal.timeout(timeoutMs),
      forceDirect,
    });
    const text = await resp.text();
    let models: UpstreamModel[] = [];
    try {
      models = parseModelsPayload(JSON.parse(text));
    } catch {
      // leave empty
    }
    return {
      ok: resp.ok,
      status: resp.status,
      latencyMs: Date.now() - started,
      modelsUrl,
      models,
      error: resp.ok
        ? models.length
          ? undefined
          : "Upstream returned no models"
        : `HTTP ${resp.status}`,
      bodyPreview: text.slice(0, 500),
    };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      latencyMs: Date.now() - started,
      modelsUrl,
      models: [],
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export function upstreamToVirtualModels(
  models: UpstreamModel[],
  options?: { ownedBy?: string },
): VirtualModel[] {
  return models.map((m) => ({
    id: m.id,
    name: m.name || m.id,
    contextWindow: m.contextWindow,
    ownedBy: options?.ownedBy ?? m.ownedBy ?? "upstream",
  }));
}

export function mergeVirtualModels(
  existing: VirtualModel[],
  incoming: VirtualModel[],
  mode: "merge" | "replace",
): VirtualModel[] {
  if (mode === "replace") return incoming.slice();
  const map = new Map(existing.map((m) => [m.id, m]));
  for (const m of incoming) {
    const prev = map.get(m.id);
    map.set(m.id, {
      id: m.id,
      name: m.name || prev?.name || m.id,
      contextWindow: m.contextWindow ?? prev?.contextWindow,
      ownedBy: m.ownedBy || prev?.ownedBy || "gbg",
    });
  }
  return [...map.values()].sort((a, b) => a.id.localeCompare(b.id));
}

export function buildIdentityMaps(
  models: UpstreamModel[],
  options?: { providerId?: string | null; onlyIds?: string[] },
): Array<{ from: string; to: string; providerId: string | null }> {
  const allow = options?.onlyIds?.length
    ? new Set(options.onlyIds)
    : null;
  return models
    .filter((m) => !allow || allow.has(m.id))
    .map((m) => ({
      from: m.id,
      to: m.id,
      providerId: options?.providerId ?? null,
    }));
}

export function mergeModelMaps(
  existing: Array<{ from: string; to: string; providerId?: string | null }>,
  incoming: Array<{ from: string; to: string; providerId?: string | null }>,
  mode: "merge" | "replace",
): Array<{ from: string; to: string; providerId: string | null }> {
  if (mode === "replace") {
    return incoming.map((m) => ({
      from: m.from,
      to: m.to,
      providerId: m.providerId ?? null,
    }));
  }
  const map = new Map(
    existing.map((m) => [
      m.from,
      { from: m.from, to: m.to, providerId: m.providerId ?? null },
    ]),
  );
  for (const m of incoming) {
    map.set(m.from, {
      from: m.from,
      to: m.to,
      providerId: m.providerId ?? null,
    });
  }
  return [...map.values()].sort((a, b) => a.from.localeCompare(b.from));
}
