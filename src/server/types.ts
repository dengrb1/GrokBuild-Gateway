import { z } from "zod";

export const ApiBackendSchema = z.enum([
  "chat_completions",
  "responses",
  "messages",
]);
export type ApiBackend = z.infer<typeof ApiBackendSchema>;

export const ProviderSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  baseUrl: z.string().url(),
  apiKey: z.string().default(""),
  apiBackend: ApiBackendSchema.default("responses"),
  modelsListUrl: z.string().url().nullable().optional().default(null),
  enabled: z.boolean().default(true),
  extraHeaders: z.record(z.string()).default({}),
  /**
   * Per-provider proxy shield (default true).
   * When true AND global server.proxyShield is on → force direct upstream.
   * When false → this provider may use system/env HTTP proxy even if global is on.
   */
  proxyShield: z.boolean().default(true),
});
export type Provider = z.infer<typeof ProviderSchema>;

export const ModelMapSchema = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
  providerId: z.string().nullable().optional().default(null),
});
export type ModelMap = z.infer<typeof ModelMapSchema>;

export const VirtualModelSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  contextWindow: z.number().int().positive().optional(),
  ownedBy: z.string().optional().default("gbg"),
});
export type VirtualModel = z.infer<typeof VirtualModelSchema>;

export const ProxyModeSchema = z.enum(["direct", "env"]);
export type ProxyMode = z.infer<typeof ProxyModeSchema>;

export const ServerConfigSchema = z.object({
  host: z.string().default("127.0.0.1"),
  port: z.number().int().min(1).max(65535).default(8787),
  gatewayToken: z.string().nullable().optional().default(null),
  requestTimeoutMs: z.number().int().positive().default(600_000),
  /**
   * Global proxy shield master switch (default true).
   * - true: upstream defaults to direct (ignore broken system proxy);
   *   loopback 127.0.0.1 is always NO_PROXY-protected.
   * - false: upstream follows HTTP(S)_PROXY / system proxy env.
   * Per-provider `proxyShield` can still force direct when global is on.
   */
  proxyShield: z.boolean().default(true),
  /**
   * Legacy mirror of proxyShield: "direct" ↔ true, "env" ↔ false.
   * Kept so older configs / CLI keep working; UI prefers proxyShield.
   */
  proxyMode: ProxyModeSchema.default("direct"),
});
export type ServerConfig = z.infer<typeof ServerConfigSchema>;

/** Effective global shield: prefer proxyShield, else derive from proxyMode. */
export function isGlobalProxyShieldOn(
  server: Pick<ServerConfig, "proxyShield" | "proxyMode"> | undefined | null,
): boolean {
  if (!server) return true;
  if (typeof server.proxyShield === "boolean") return server.proxyShield;
  return (server.proxyMode ?? "direct") !== "env";
}

/**
 * Whether a single upstream call should force direct (no system proxy).
 * Requires global ON and provider ON (provider default true).
 */
export function isProviderProxyShieldOn(
  server: Pick<ServerConfig, "proxyShield" | "proxyMode"> | undefined | null,
  provider: Pick<Provider, "proxyShield"> | undefined | null,
): boolean {
  if (!isGlobalProxyShieldOn(server)) return false;
  if (provider && typeof provider.proxyShield === "boolean") {
    return provider.proxyShield;
  }
  return true;
}

export function proxyModeFromShield(on: boolean): ProxyMode {
  return on ? "direct" : "env";
}

export const GbgConfigSchema = z.object({
  version: z.literal(1).default(1),
  server: ServerConfigSchema.default({}),
  activeProviderId: z.string().min(1),
  providers: z.array(ProviderSchema).min(1),
  modelMaps: z.array(ModelMapSchema).default([]),
  virtualModels: z.array(VirtualModelSchema).default([]),
});
export type GbgConfig = z.infer<typeof GbgConfigSchema>;

export interface RequestLogEntry {
  id: string;
  ts: number;
  method: string;
  path: string;
  modelIn: string | null;
  modelOut: string | null;
  providerId: string | null;
  status: number;
  /** Backward-compatible alias for the time until upstream response headers. */
  latencyMs: number;
  /** Time spent serializing/parsing and preparing the upstream request body. */
  requestBodyMs?: number;
  /** Time spent waiting for the upstream response headers after fetch started. */
  upstreamHeadersMs?: number;
  /** End-to-end time until the upstream response headers became available. */
  firstByteMs?: number;
  /** End-to-end time until the complete response/stream finished. */
  durationMs?: number;
  clientProtocol?: ApiBackend | null;
  upstreamProtocol?: ApiBackend;
  proxyMode?: "direct" | "env";
  errorStage?: string;
  streamStarted?: boolean;
  error?: string;
  stream?: boolean;
}

export interface ResolvedRoute {
  provider: Provider;
  modelIn: string | null;
  modelOut: string | null;
  mapped: boolean;
}

export function createDefaultConfig(): GbgConfig {
  return GbgConfigSchema.parse({
    version: 1,
    server: {
      host: "127.0.0.1",
      port: 8787,
      gatewayToken: null,
      requestTimeoutMs: 600_000,
      proxyShield: true,
      proxyMode: "direct",
    },
    activeProviderId: "okinto",
    providers: [
      {
        id: "okinto",
        name: "Okinto",
        baseUrl: "https://api.okinto.com/v1",
        apiKey: "env:OKINTO_API_KEY",
        apiBackend: "responses",
        modelsListUrl: null,
        enabled: true,
        proxyShield: true,
        extraHeaders: {},
      },
      {
        id: "ccx",
        name: "CCX",
        baseUrl: "https://ccx.dengrb.top/v1",
        apiKey: "env:CCX_API_KEY",
        apiBackend: "responses",
        modelsListUrl: null,
        enabled: true,
        proxyShield: true,
        extraHeaders: {},
      },
      {
        id: "xai",
        name: "xAI Official",
        baseUrl: "https://api.x.ai/v1",
        apiKey: "env:XAI_API_KEY",
        apiBackend: "responses",
        modelsListUrl: null,
        enabled: true,
        proxyShield: true,
        extraHeaders: {},
      },
      {
        id: "anthropic",
        name: "Anthropic",
        baseUrl: "https://api.anthropic.com/v1",
        apiKey: "env:ANTHROPIC_API_KEY",
        apiBackend: "messages",
        modelsListUrl: null,
        enabled: true,
        proxyShield: true,
        extraHeaders: {
          "anthropic-version": "2023-06-01",
        },
      },
      {
        id: "openai-responses",
        name: "OpenAI (Responses)",
        baseUrl: "https://api.openai.com/v1",
        apiKey: "env:OPENAI_API_KEY",
        apiBackend: "responses",
        modelsListUrl: null,
        enabled: true,
        proxyShield: true,
        extraHeaders: {},
      },
    ],
    modelMaps: [
      { from: "grok-4.5", to: "grok-4.5", providerId: null },
      { from: "grok-build", to: "grok-4.5", providerId: null },
    ],
    virtualModels: [
      {
        id: "grok-4.5",
        name: "Grok 4.5",
        contextWindow: 500_000,
        ownedBy: "gbg",
      },
      {
        id: "grok-build",
        name: "Grok Build alias",
        contextWindow: 500_000,
        ownedBy: "gbg",
      },
    ],
  });
}
