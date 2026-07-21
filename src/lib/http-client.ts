/**
 * Fetch helpers that respect global + per-provider proxy shield.
 *
 * - Loopback (local control API) never uses a proxy (NO_PROXY + 127.0.0.1).
 * - Upstream: force direct when shield effective; otherwise use saved env proxy.
 */

import {
  applyProxyShield,
  gatewayBaseUrl,
  getProxyShieldState,
  getSavedProxyUrl,
  type ProxyMode,
  withEnvProxy,
} from "./proxy-shield.js";

export type { ProxyMode };

export interface UpstreamFetchOptions extends RequestInit {
  /** When true (default), bypass system/env HTTP proxy for this request. */
  forceDirect?: boolean;
}

/** Ensure shield process state is applied at least once. */
export function ensureProxyShield(mode: ProxyMode = "direct"): void {
  applyProxyShield(mode);
}

/**
 * Fetch against the local gateway control plane.
 * Host is always normalized to 127.0.0.1 for bind-all / localhost.
 */
export async function localFetch(
  bindHost: string | undefined | null,
  port: number,
  path: string,
  init?: RequestInit,
): Promise<Response> {
  ensureProxyShield(getProxyShieldState()?.mode ?? "direct");
  const base = gatewayBaseUrl(bindHost, port);
  const url = path.startsWith("http")
    ? path
    : `${base}${path.startsWith("/") ? path : `/${path}`}`;
  return fetch(url, {
    ...init,
    ...(supportsFetchProxyOption() ? { proxy: null } : {}),
  } as RequestInit);
}

/**
 * Upstream provider fetch.
 * @param forceDirect - true: never use HTTP(S)_PROXY; false: use saved/env proxy
 */
export async function upstreamFetch(
  url: string | URL,
  init?: UpstreamFetchOptions,
): Promise<Response> {
  const { forceDirect = true, ...rest } = init ?? {};
  ensureProxyShield(getProxyShieldState()?.mode ?? "direct");

  if (forceDirect) {
    const opts: RequestInit & { proxy?: null | string } = { ...rest };
    if (supportsFetchProxyOption()) {
      opts.proxy = null;
    }
    return fetch(url, opts as RequestInit);
  }

  // Allow system/env proxy for this call
  if (supportsFetchProxyOption()) {
    const proxyUrl = getSavedProxyUrl();
    const opts: RequestInit & { proxy?: null | string } = { ...rest };
    if (proxyUrl) opts.proxy = proxyUrl;
    // If no saved proxy, leave unset so Bun may still read env if present
    return fetch(url, opts as RequestInit);
  }

  return withEnvProxy(() => fetch(url, rest));
}

function supportsFetchProxyOption(): boolean {
  return Boolean(
    typeof process !== "undefined" &&
      process.versions &&
      "bun" in process.versions,
  );
}
