import { getConfigStore } from "../server/config-store.js";
import {
  applyProxyShield,
  gatewayBaseUrl,
  gatewayLoopbackHost,
} from "./proxy-shield.js";
import { isGlobalProxyShieldOn, proxyModeFromShield } from "../server/types.js";

/**
 * Base URL for talking to a running local gateway from this process.
 * Always uses 127.0.0.1 when bind host is 0.0.0.0 / localhost to avoid
 * system-proxy + ::1 quirks.
 */
export function getLocalBaseUrl(): string {
  const cfg = getConfigStore().get();
  applyProxyShield(proxyModeFromShield(isGlobalProxyShieldOn(cfg.server)));
  return gatewayBaseUrl(cfg.server.host, cfg.server.port);
}

export function getLocalLoopbackHost(): string {
  const cfg = getConfigStore().get();
  return gatewayLoopbackHost(cfg.server.host);
}

export async function tryLocalApi<T>(
  path: string,
  init?: RequestInit,
): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
  const base = getLocalBaseUrl();
  try {
    const resp = await fetch(`${base}${path}`, {
      ...init,
      headers: {
        "content-type": "application/json",
        ...(init?.headers ?? {}),
      },
      signal: AbortSignal.timeout(3000),
    });
    const text = await resp.text();
    let data: unknown = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }
    if (!resp.ok) {
      const msg =
        typeof data === "object" &&
        data &&
        "error" in data &&
        typeof (data as { error: unknown }).error === "string"
          ? (data as { error: string }).error
          : `HTTP ${resp.status}`;
      return { ok: false, error: msg };
    }
    return { ok: true, data: data as T };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function isServerRunning(): Promise<boolean> {
  const r = await tryLocalApi<{ ok?: boolean }>("/api/health");
  return r.ok && r.data?.ok === true;
}
