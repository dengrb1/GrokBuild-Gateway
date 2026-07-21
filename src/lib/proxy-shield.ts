/**
 * Prevent system / env HTTP proxies from breaking access to the local gateway
 * (and optionally force direct upstream connections).
 *
 * Priority:
 * 1. Loopback (127.0.0.1 / localhost / ::1) must never go through a proxy
 * 2. Upstream fetches default to direct (proxyMode=direct)
 */

export type ProxyMode = "direct" | "env";

export const LOOPBACK_NO_PROXY = [
  "127.0.0.1",
  "localhost",
  "::1",
  "0.0.0.0",
] as const;

const PROXY_ENV_KEYS = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
] as const;

export interface SavedProxyEnv {
  [key: string]: string | undefined;
}

export interface ProxyShieldState {
  mode: ProxyMode;
  applied: boolean;
  noProxy: string;
  strippedProxyKeys: string[];
  hadProxyEnv: boolean;
  saved: SavedProxyEnv;
}

let state: ProxyShieldState | null = null;

/** Split / merge NO_PROXY lists (comma or semicolon). */
export function parseNoProxyList(value: string | undefined | null): string[] {
  if (!value?.trim()) return [];
  return value
    .split(/[,;]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function mergeNoProxy(
  existing: string | undefined | null,
  extras: readonly string[] = LOOPBACK_NO_PROXY,
): string {
  const set = new Map<string, string>();
  for (const item of [...parseNoProxyList(existing), ...extras]) {
    const key = item.toLowerCase();
    if (!set.has(key)) set.set(key, item);
  }
  return [...set.values()].join(",");
}

export function noProxyCoversLoopback(
  noProxy: string | undefined | null,
): boolean {
  const items = parseNoProxyList(noProxy).map((s) => s.toLowerCase());
  if (items.includes("*") || items.includes("<local>")) return true;
  return (
    items.includes("127.0.0.1") ||
    items.includes("localhost") ||
    items.includes("::1")
  );
}

export function detectProxyEnv(
  env: NodeJS.ProcessEnv = process.env,
): { present: boolean; keys: string[]; values: SavedProxyEnv } {
  const values: SavedProxyEnv = {};
  const keys: string[] = [];
  for (const k of PROXY_ENV_KEYS) {
    const v = env[k];
    if (v?.trim()) {
      keys.push(k);
      values[k] = v;
    }
  }
  return { present: keys.length > 0, keys, values };
}

/**
 * Canonical URL host for talking to *this* gateway from the same machine.
 * Always prefer 127.0.0.1 over localhost / bind-all addresses.
 */
export function gatewayLoopbackHost(bindHost: string | undefined | null): string {
  const h = (bindHost ?? "127.0.0.1").trim().toLowerCase();
  if (
    !h ||
    h === "0.0.0.0" ||
    h === "::" ||
    h === "[::]" ||
    h === "localhost" ||
    h === "::1" ||
    h === "[::1]"
  ) {
    return "127.0.0.1";
  }
  return bindHost!.trim();
}

export function gatewayBaseUrl(
  bindHost: string | undefined | null,
  port: number,
): string {
  return `http://${gatewayLoopbackHost(bindHost)}:${port}`;
}

export function getProxyShieldState(): ProxyShieldState | null {
  return state;
}

/** First non-empty saved proxy URL (HTTP_PROXY / HTTPS_PROXY / …). */
export function getSavedProxyUrl(
  shield: ProxyShieldState | null = state,
): string | undefined {
  if (shield?.saved) {
    for (const k of PROXY_ENV_KEYS) {
      const v = shield.saved[k]?.trim();
      if (v) return v;
    }
  }
  for (const k of PROXY_ENV_KEYS) {
    const v = process.env[k]?.trim();
    if (v) return v;
  }
  return undefined;
}

/**
 * Temporarily restore saved proxy env for a single call, then re-strip if mode is direct.
 * Used when per-provider shield is off under Node (no Bun proxy option).
 */
export async function withEnvProxy<T>(fn: () => Promise<T>): Promise<T> {
  const s = state;
  const env = process.env;
  if (!s?.saved || Object.keys(s.saved).length === 0) {
    return fn();
  }
  const restored: string[] = [];
  for (const [k, v] of Object.entries(s.saved)) {
    if (v !== undefined && env[k] === undefined) {
      env[k] = v;
      restored.push(k);
    }
  }
  try {
    return await fn();
  } finally {
    if (s.mode === "direct") {
      for (const k of restored) {
        delete env[k];
      }
    }
  }
}

/**
 * Apply process-level proxy protection. Safe to call multiple times; can switch modes.
 * - Always strengthens NO_PROXY for loopback
 * - In `direct` mode, strips HTTP(S)_PROXY env so undici/Bun fetch go direct
 * - In `env` mode, restores previously saved proxy vars
 */
export function applyProxyShield(
  mode: ProxyMode = "direct",
  env: NodeJS.ProcessEnv = process.env,
): ProxyShieldState {
  const live = detectProxyEnv(env);
  const prevSaved: SavedProxyEnv = { ...(state?.saved ?? {}) };
  for (const [k, v] of Object.entries(live.values)) {
    if (v !== undefined) prevSaved[k] = v;
  }

  const noProxy = mergeNoProxy(env.NO_PROXY ?? env.no_proxy);
  env.NO_PROXY = noProxy;
  env.no_proxy = noProxy;

  const stripped: string[] = [];

  if (mode === "direct") {
    for (const k of PROXY_ENV_KEYS) {
      if (env[k] !== undefined) {
        if (!(k in prevSaved)) prevSaved[k] = env[k];
        delete env[k];
        stripped.push(k);
      } else if (prevSaved[k] !== undefined) {
        stripped.push(k);
      }
    }
  } else {
    for (const [k, v] of Object.entries(prevSaved)) {
      if (v !== undefined) env[k] = v;
    }
  }

  const hadProxy =
    Object.values(prevSaved).some((v) => Boolean(v?.trim())) || live.present;

  state = {
    mode,
    applied: true,
    noProxy,
    strippedProxyKeys: mode === "direct" ? stripped : [],
    hadProxyEnv: hadProxy,
    saved: prevSaved,
  };
  return state;
}

/** Restore previously stripped proxy env (rarely needed; for tests). */
export function restoreProxyEnv(
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (!state) return;
  for (const [k, v] of Object.entries(state.saved)) {
    if (v !== undefined) env[k] = v;
  }
  state = null;
}

export interface ProxyDoctorFinding {
  level: "ok" | "warn" | "error";
  code: string;
  message: string;
}

export function diagnoseProxyEnv(
  env: NodeJS.ProcessEnv = process.env,
  shield: ProxyShieldState | null = state,
): ProxyDoctorFinding[] {
  const findings: ProxyDoctorFinding[] = [];
  const detected = detectProxyEnv(env);
  // Also consider saved proxies from before strip
  const hadProxy =
    detected.present || Boolean(shield?.hadProxyEnv);

  const noProxy = env.NO_PROXY ?? env.no_proxy ?? shield?.noProxy;
  const covers = noProxyCoversLoopback(noProxy);

  if (shield?.applied) {
    findings.push({
      level: "ok",
      code: "shield_applied",
      message: `proxy shield active (mode=${shield.mode}, NO_PROXY covers loopback)`,
    });
  }

  if (hadProxy && !covers && !shield?.applied) {
    findings.push({
      level: "warn",
      code: "proxy_without_loopback_bypass",
      message:
        "HTTP(S)_PROXY is set but NO_PROXY does not include 127.0.0.1/localhost — " +
        "Grok/browser may fail to reach the local gateway. " +
        "Add 127.0.0.1,localhost,::1 to NO_PROXY, or enable Windows proxy bypass for local addresses.",
    });
  } else if (hadProxy && covers) {
    findings.push({
      level: "ok",
      code: "proxy_with_bypass",
      message:
        "Proxy env present but NO_PROXY includes loopback (or shield stripped proxies)",
    });
  } else if (!hadProxy) {
    findings.push({
      level: "ok",
      code: "no_proxy_env",
      message: "No HTTP(S)_PROXY env vars detected",
    });
  }

  if (shield?.mode === "direct" && shield.strippedProxyKeys.length) {
    findings.push({
      level: "ok",
      code: "upstream_direct",
      message: `Upstream forced direct (cleared: ${shield.strippedProxyKeys.join(", ")})`,
    });
  }

  findings.push({
    level: "ok",
    code: "address_hint",
    message:
      "Always use http://127.0.0.1:<port> (not localhost) for Grok base_url to avoid ::1 / proxy quirks",
  });

  return findings;
}

/** Redact proxy URL credentials for logs. */
export function redactProxyUrl(url: string | undefined): string {
  if (!url) return "";
  try {
    const u = new URL(url);
    if (u.username || u.password) {
      u.username = u.username ? "***" : "";
      u.password = u.password ? "***" : "";
    }
    return u.toString();
  } catch {
    return "[invalid-proxy-url]";
  }
}
