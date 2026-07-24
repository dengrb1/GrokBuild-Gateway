import { existsSync, readFileSync } from "node:fs";
import { Hono } from "hono";
import { z } from "zod";
import type { ConfigStore } from "./config-store.js";
import {
  ModelMapSchema,
  ProviderSchema,
  VirtualModelSchema,
  isGlobalProxyShieldOn,
  proxyModeFromShield,
  type GbgConfig,
} from "./types.js";
import { globalRequestLog } from "../lib/request-log.js";
import { getActiveProvider, upsertModelMap, removeModelMap } from "../lib/model-map.js";
import { listProviderHealth } from "../lib/provider-health.js";
import {
  buildIdentityMaps,
  fetchUpstreamModels,
  mergeModelMaps,
  mergeVirtualModels,
  upstreamToVirtualModels,
} from "../lib/upstream-models.js";
import { applyGrokConfig } from "../lib/grok-apply.js";
import { buildGrokBootstrapSnippet } from "../lib/bootstrap-snippet.js";
import { getGrokConfigPath } from "../lib/paths.js";
import {
  applyProxyShield,
  diagnoseProxyEnv,
  gatewayBaseUrl,
  getProxyShieldState,
} from "../lib/proxy-shield.js";

const ActiveProviderBody = z.object({ id: z.string().min(1) });

const TestProviderBody = z.object({
  id: z.string().min(1).optional(),
});

const FetchModelsBody = z.object({
  id: z.string().min(1).optional(),
});

const ImportModelsBody = z.object({
  id: z.string().min(1).optional(),
  mode: z.enum(["merge", "replace"]).default("merge"),
  target: z
    .enum(["virtual", "maps", "both"])
    .default("both"),
  /** Optional subset of upstream model ids; default = all fetched */
  modelIds: z.array(z.string()).optional(),
  /** When creating maps, pin providerId (default: the source provider id) */
  pinProvider: z.boolean().default(false),
});

const VirtualModelPatch = VirtualModelSchema.extend({
  /** When renaming id */
  previousId: z.string().optional(),
});

const ProxyShieldBody = z.object({
  enabled: z.boolean(),
});

function syncProcessShield(cfg: GbgConfig) {
  const on = isGlobalProxyShieldOn(cfg.server);
  return applyProxyShield(proxyModeFromShield(on));
}

function proxyShieldPayload(cfg: GbgConfig) {
  const shield = getProxyShieldState() ?? syncProcessShield(cfg);
  const enabled = isGlobalProxyShieldOn(cfg.server);
  return {
    enabled,
    mode: shield.mode,
    noProxy: shield.noProxy,
    hadProxyEnv: shield.hadProxyEnv,
    strippedProxyKeys: shield.strippedProxyKeys,
  };
}

export function createControlApi(store: ConfigStore): Hono {
  const api = new Hono();

  api.get("/health", (c) => {
    const cfg = store.get();
    const shieldInfo = proxyShieldPayload(cfg);
    let activeName: string | null = null;
    try {
      activeName = getActiveProvider(cfg).name;
    } catch {
      activeName = null;
    }
    const publicBase = gatewayBaseUrl(cfg.server.host, cfg.server.port);
    return c.json({
      ok: true,
      name: "grokbuild-gateway",
      version: "0.3.0",
      rev: store.revision,
      logRev: globalRequestLog.revision,
      activeProviderId: cfg.activeProviderId,
      activeProviderName: activeName,
      port: cfg.server.port,
      host: cfg.server.host,
      publicBase,
      configPath: store.path,
      dataHome: store.gbgHome,
      proxyShield: shieldInfo,
      failover: cfg.server.failover ?? null,
      providerHealth: listProviderHealth(),
    });
  });

  api.get("/failover", (c) => {
    const cfg = store.get();
    return c.json({
      failover: cfg.server.failover ?? {
        enabled: true,
        maxAttempts: 3,
        firstByteTimeoutMs: 30000,
        cooldownMs: 60000,
        consecutiveFailures: 2,
      },
      providerHealth: listProviderHealth(),
    });
  });


  /**
   * Single round-trip for the Web UI poller.
   * ?rev=&logRev= → 204 when nothing changed (zero body).
   * ?logs=0 skips log payload.
   */
  api.get("/snapshot", (c) => {
    const qRev = Number(c.req.query("rev") ?? "0");
    const qLogRev = Number(c.req.query("logRev") ?? "0");
    const wantLogs = c.req.query("logs") !== "0";
    const logLimit = Math.min(80, Math.max(1, Number(c.req.query("limit") ?? "40")));

    const rev = store.revision;
    const logRev = globalRequestLog.revision;
    if (qRev === rev && qLogRev === logRev && qRev > 0) {
      return new Response(null, { status: 204 });
    }

    const cfg = store.get();
    let activeName: string | null = null;
    try {
      activeName = getActiveProvider(cfg).name;
    } catch {
      activeName = null;
    }

    const base = gatewayBaseUrl(cfg.server.host, cfg.server.port);
    const shieldInfo = proxyShieldPayload(cfg);
    const shield = getProxyShieldState();
    const grokPath = getGrokConfigPath();
    let grokExists = false;
    let pointedAtGateway = false;
    try {
      grokExists = existsSync(grokPath);
      if (grokExists) {
        const text = readFileSync(grokPath, "utf8");
        pointedAtGateway =
          text.includes(base) ||
          text.includes(`127.0.0.1:${cfg.server.port}`) ||
          text.includes("127.0.0.1:8787");
      }
    } catch {
      // ignore
    }

    return c.json({
      rev,
      logRev,
      health: {
        ok: true,
        name: "grokbuild-gateway",
        version: "0.3.0",
        activeProviderId: cfg.activeProviderId,
        activeProviderName: activeName,
        port: cfg.server.port,
        host: cfg.server.host,
        publicBase: base,
        configPath: store.path,
        dataHome: store.gbgHome,
        proxyShield: shieldInfo,
        failover: cfg.server.failover ?? null,
        providerHealth: listProviderHealth(),
      },
      config: store.redact(),
      stats: globalRequestLog.stats(),
      bootstrap: {
        baseUrl: `${base}/v1`,
        grokConfigPath: grokPath,
        snippet: buildGrokBootstrapSnippet(cfg),
      },
      proxyFindings: diagnoseProxyEnv(process.env, shield),
      grokStatus: {
        path: grokPath,
        exists: grokExists,
        pointedAtGateway,
        gatewayBase: `${base}/v1`,
      },
      logs: wantLogs ? globalRequestLog.list(logLimit) : undefined,
    });
  });

  api.get("/config", (c) => c.json(store.redact()));

  api.get("/config/backups", (c) => {
    return c.json({ backups: store.listBackups() });
  });

  const ResetBody = z.object({
    mode: z.enum(["defaults", "backup"]).default("defaults"),
    backup: z.string().optional(),
  });

  /** Restore factory defaults or a previous backup (current file is backed up first). */
  api.post("/config/reset", async (c) => {
    try {
      const body = ResetBody.parse((await c.req.json().catch(() => ({}))) || {});
      const result =
        body.mode === "backup"
          ? store.restoreFromBackup(body.backup)
          : store.resetToDefaults();
      return c.json({
        ok: true,
        mode: result.mode,
        backupPath: result.backupPath,
        restoredFrom: result.restoredFrom ?? null,
        config: store.redact(),
        message:
          result.mode === "defaults"
            ? "已还原为默认配置"
            : `已从备份还原: ${result.restoredFrom}`,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ ok: false, error: message }, 400);
    }
  });


  /** Toggle global proxy shield (master switch). */
  api.get("/proxy-shield", (c) => {
    const cfg = store.get();
    return c.json(proxyShieldPayload(cfg));
  });

  api.post("/proxy-shield", async (c) => {
    try {
      const body = ProxyShieldBody.parse(await c.req.json());
      store.update((cfg) => {
        cfg.server.proxyShield = body.enabled;
        cfg.server.proxyMode = proxyModeFromShield(body.enabled);
        return cfg;
      });
      const cfg = store.get();
      syncProcessShield(cfg);
      return c.json(proxyShieldPayload(cfg));
    } catch (err) {
      return c.json(
        { error: err instanceof Error ? err.message : String(err) },
        400,
      );
    }
  });

  api.put("/config", async (c) => {
    try {
      const body = (await c.req.json()) as GbgConfig;
      // When UI sends redacted keys (**** or masked), keep existing secrets
      const current = store.snapshot();
      if (body.providers) {
        body.providers = body.providers.map((p) => {
          const prev = current.providers.find((x) => x.id === p.id);
          if (prev && isMasked(p.apiKey) && prev.apiKey) {
            return { ...p, apiKey: prev.apiKey };
          }
          return p;
        });
      }
      if (
        body.server?.gatewayToken &&
        isMasked(body.server.gatewayToken) &&
        current.server.gatewayToken
      ) {
        body.server.gatewayToken = current.server.gatewayToken;
      }
      // Keep proxyShield / proxyMode in sync if either is set
      if (body.server) {
        if (typeof body.server.proxyShield === "boolean") {
          body.server.proxyMode = proxyModeFromShield(body.server.proxyShield);
        } else if (body.server.proxyMode) {
          body.server.proxyShield = body.server.proxyMode !== "env";
        }
      }
      store.replace(body);
      syncProcessShield(store.get());
      return c.json(store.redact());
    } catch (err) {
      return c.json(
        { error: err instanceof Error ? err.message : String(err) },
        400,
      );
    }
  });

  api.get("/providers", (c) => {
    const redacted = store.redact();
    return c.json({
      activeProviderId: redacted.activeProviderId,
      providers: redacted.providers,
    });
  });

  api.post("/providers", async (c) => {
    try {
      const body = ProviderSchema.parse(await c.req.json());
      store.upsertProvider(body);
      return c.json(store.redact().providers.find((p) => p.id === body.id), 201);
    } catch (err) {
      return c.json(
        { error: err instanceof Error ? err.message : String(err) },
        400,
      );
    }
  });

  api.patch("/providers/:id", async (c) => {
    try {
      const id = c.req.param("id");
      const patch = (await c.req.json()) as Partial<GbgConfig["providers"][0]>;
      const current = store.snapshot();
      const existing = current.providers.find((p) => p.id === id);
      if (!existing) return c.json({ error: `Provider not found: ${id}` }, 404);
      const merged = ProviderSchema.parse({
        ...existing,
        ...patch,
        id,
        apiKey:
          patch.apiKey !== undefined && !isMasked(patch.apiKey)
            ? patch.apiKey
            : existing.apiKey,
      });
      store.upsertProvider(merged);
      return c.json(store.redact().providers.find((p) => p.id === id));
    } catch (err) {
      return c.json(
        { error: err instanceof Error ? err.message : String(err) },
        400,
      );
    }
  });

  api.delete("/providers/:id", (c) => {
    try {
      store.removeProvider(c.req.param("id"));
      return c.json({ ok: true });
    } catch (err) {
      return c.json(
        { error: err instanceof Error ? err.message : String(err) },
        400,
      );
    }
  });

  api.post("/active-provider", async (c) => {
    try {
      const { id } = ActiveProviderBody.parse(await c.req.json());
      store.setActiveProvider(id);
      return c.json({
        ok: true,
        activeProviderId: store.get().activeProviderId,
      });
    } catch (err) {
      return c.json(
        { error: err instanceof Error ? err.message : String(err) },
        400,
      );
    }
  });

  api.get("/model-maps", (c) => c.json({ modelMaps: store.get().modelMaps }));

  api.put("/model-maps", async (c) => {
    try {
      const body = z.array(ModelMapSchema).parse(await c.req.json());
      store.setModelMaps(body);
      return c.json({ modelMaps: store.get().modelMaps });
    } catch (err) {
      return c.json(
        { error: err instanceof Error ? err.message : String(err) },
        400,
      );
    }
  });

  api.post("/model-maps", async (c) => {
    try {
      const entry = ModelMapSchema.parse(await c.req.json());
      store.update((cfg) => {
        cfg.modelMaps = upsertModelMap(cfg.modelMaps, entry);
        return cfg;
      });
      return c.json(entry, 201);
    } catch (err) {
      return c.json(
        { error: err instanceof Error ? err.message : String(err) },
        400,
      );
    }
  });

  api.delete("/model-maps/:from", (c) => {
    const from = decodeURIComponent(c.req.param("from"));
    store.update((cfg) => {
      cfg.modelMaps = removeModelMap(cfg.modelMaps, from);
      return cfg;
    });
    return c.json({ ok: true });
  });

  api.get("/virtual-models", (c) =>
    c.json({ virtualModels: store.get().virtualModels }),
  );

  api.put("/virtual-models", async (c) => {
    try {
      const body = z.array(VirtualModelSchema).parse(await c.req.json());
      store.setVirtualModels(body);
      return c.json({ virtualModels: store.get().virtualModels });
    } catch (err) {
      return c.json(
        { error: err instanceof Error ? err.message : String(err) },
        400,
      );
    }
  });

  api.post("/virtual-models", async (c) => {
    try {
      const entry = VirtualModelPatch.parse(await c.req.json());
      const previousId = entry.previousId;
      store.update((cfg) => {
        let list = cfg.virtualModels.slice();
        if (previousId && previousId !== entry.id) {
          list = list.filter((m) => m.id !== previousId);
        }
        const idx = list.findIndex((m) => m.id === entry.id);
        const next = {
          id: entry.id,
          name: entry.name,
          contextWindow: entry.contextWindow,
          ownedBy: entry.ownedBy ?? "gbg",
        };
        if (idx === -1) list.push(next);
        else list[idx] = next;
        // If renamed, update maps that pointed at old id as `from`
        if (previousId && previousId !== entry.id) {
          cfg.modelMaps = cfg.modelMaps.map((m) =>
            m.from === previousId ? { ...m, from: entry.id } : m,
          );
        }
        cfg.virtualModels = list;
        return cfg;
      });
      return c.json(
        store.get().virtualModels.find((m) => m.id === entry.id),
        201,
      );
    } catch (err) {
      return c.json(
        { error: err instanceof Error ? err.message : String(err) },
        400,
      );
    }
  });

  api.delete("/virtual-models/:id", (c) => {
    const id = decodeURIComponent(c.req.param("id"));
    store.update((cfg) => {
      cfg.virtualModels = cfg.virtualModels.filter((m) => m.id !== id);
      return cfg;
    });
    return c.json({ ok: true });
  });

  api.get("/logs", (c) => {
    const limit = Number(c.req.query("limit") ?? "50");
    return c.json({ logs: globalRequestLog.list(limit) });
  });

  api.get("/stats", (c) => c.json(globalRequestLog.stats()));

  api.post("/test-provider", async (c) => {
    try {
      const body = TestProviderBody.parse(
        (await c.req.json().catch(() => ({}))) ?? {},
      );
      const cfg = store.get();
      const id = body.id ?? cfg.activeProviderId;
      const provider = cfg.providers.find((p) => p.id === id);
      if (!provider) return c.json({ error: `Provider not found: ${id}` }, 404);

      const result = await fetchUpstreamModels(provider, { server: cfg.server });
      return c.json({
        ok: result.ok,
        status: result.status,
        latencyMs: result.latencyMs,
        modelsUrl: result.modelsUrl,
        sampleModels: result.models.map((m) => m.id).slice(0, 30),
        modelCount: result.models.length,
        bodyPreview: result.bodyPreview,
        error: result.error,
        proxyShield: isGlobalProxyShieldOn(cfg.server) && (provider.proxyShield !== false),
      });
    } catch (err) {
      return c.json(
        {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        },
        502,
      );
    }
  });

  /** Fetch upstream model catalog (full list) without writing config. */
  api.post("/fetch-models", async (c) => {
    try {
      const body = FetchModelsBody.parse(
        (await c.req.json().catch(() => ({}))) ?? {},
      );
      const cfg = store.get();
      const id = body.id ?? cfg.activeProviderId;
      const provider = cfg.providers.find((p) => p.id === id);
      if (!provider) return c.json({ error: `Provider not found: ${id}` }, 404);

      const result = await fetchUpstreamModels(provider, { server: cfg.server });
      return c.json({
        ...result,
        providerId: provider.id,
        providerName: provider.name,
      });
    } catch (err) {
      return c.json(
        {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        },
        502,
      );
    }
  });

  /**
   * Pull upstream models into virtualModels and/or identity modelMaps.
   * mode=merge keeps existing entries; replace overwrites the target list.
   */
  api.post("/import-models", async (c) => {
    try {
      const body = ImportModelsBody.parse(
        (await c.req.json().catch(() => ({}))) ?? {},
      );
      const cfg = store.get();
      const id = body.id ?? cfg.activeProviderId;
      const provider = cfg.providers.find((p) => p.id === id);
      if (!provider) return c.json({ error: `Provider not found: ${id}` }, 404);

      const result = await fetchUpstreamModels(provider, { server: cfg.server });
      if (!result.ok) {
        return c.json(
          {
            ok: false,
            error: result.error || "fetch failed",
            status: result.status,
            modelsUrl: result.modelsUrl,
          },
          502,
        );
      }

      let models = result.models;
      if (body.modelIds?.length) {
        const allow = new Set(body.modelIds);
        models = models.filter((m) => allow.has(m.id));
      }

      const virtualIncoming = upstreamToVirtualModels(models, {
        ownedBy: provider.id,
      });
      const mapIncoming = buildIdentityMaps(models, {
        providerId: body.pinProvider ? provider.id : null,
      });

      store.update((draft) => {
        if (body.target === "virtual" || body.target === "both") {
          draft.virtualModels = mergeVirtualModels(
            draft.virtualModels,
            virtualIncoming,
            body.mode,
          );
        }
        if (body.target === "maps" || body.target === "both") {
          draft.modelMaps = mergeModelMaps(
            draft.modelMaps,
            mapIncoming,
            body.mode,
          );
        }
        return draft;
      });

      return c.json({
        ok: true,
        providerId: provider.id,
        imported: models.length,
        mode: body.mode,
        target: body.target,
        modelsUrl: result.modelsUrl,
        latencyMs: result.latencyMs,
        virtualModels: store.get().virtualModels,
        modelMaps: store.get().modelMaps,
      });
    } catch (err) {
      return c.json(
        {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        },
        400,
      );
    }
  });

  api.get("/bootstrap-snippet", (c) => {
    const cfg = store.get();
    const base = `${gatewayBaseUrl(cfg.server.host, cfg.server.port)}/v1`;
    return c.json({
      baseUrl: base,
      grokConfigPath: getGrokConfigPath(),
      snippet: buildGrokBootstrapSnippet(cfg),
    });
  });

  /** One-click patch ~/.grok/config.toml to point at this gateway (with backup). */
  api.post("/apply-grok", async (c) => {
    try {
      const result = applyGrokConfig(store.get());
      return c.json(result);
    } catch (err) {
      return c.json(
        {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        },
        500,
      );
    }
  });

  api.get("/grok-status", (c) => {
    const cfg = store.get();
    const path = getGrokConfigPath();
    const base = gatewayBaseUrl(cfg.server.host, cfg.server.port);
    let pointed = false;
    let exists = false;
    try {
      exists = existsSync(path);
      if (exists) {
        const text = readFileSync(path, "utf8");
        pointed =
          text.includes(base) ||
          text.includes(`127.0.0.1:${cfg.server.port}`) ||
          text.includes("127.0.0.1:8787");
      }
    } catch {
      // ignore
    }
    return c.json({
      path,
      exists,
      pointedAtGateway: pointed,
      gatewayBase: `${base}/v1`,
    });
  });

  return api;
}

function isMasked(value: string | null | undefined): boolean {
  if (!value) return false;
  if (value.startsWith("env:")) return false;
  return value.includes("…") || value.includes("****") || value === "****";
}
