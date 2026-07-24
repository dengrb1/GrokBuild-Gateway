#!/usr/bin/env node
import { Command } from "commander";
import { getConfigStore } from "./server/config-store.js";
import { startServer } from "./server/index.js";
import { ProviderSchema, type Provider } from "./server/types.js";
import {
  removeModelMap,
  upsertModelMap,
  getActiveProvider,
} from "./lib/model-map.js";
import { resolveSecret, maskSecret } from "./lib/secrets.js";
import { getGrokConfigPath } from "./lib/paths.js";
import { buildGrokBootstrapSnippet } from "./lib/bootstrap-snippet.js";
import { isServerRunning, tryLocalApi } from "./lib/local-api.js";
import { applyGrokConfig } from "./lib/grok-apply.js";
import {
  applyProxyShield,
  diagnoseProxyEnv,
  gatewayBaseUrl,
  getProxyShieldState,
} from "./lib/proxy-shield.js";
import { upstreamFetch } from "./lib/http-client.js";
import {
  isGlobalProxyShieldOn,
  isProviderProxyShieldOn,
  proxyModeFromShield,
} from "./server/types.js";
import {
  buildIdentityMaps,
  fetchUpstreamModels,
  mergeModelMaps,
  mergeVirtualModels,
  upstreamToVirtualModels,
} from "./lib/upstream-models.js";
import { existsSync, readFileSync } from "node:fs";

// Strengthen NO_PROXY for loopback ASAP so any early local fetch is safe.
// Full direct-mode strip happens once config (proxyMode) is known.
applyProxyShield("direct");

const program = new Command();

program
  .name("gbg")
  .description(
    "GrokBuild Gateway — switch model providers for Grok Build without restarting",
  )
  .version("0.3.0");

program
  .command("serve")
  .description("Start the local gateway + Web UI")
  .option("-p, --port <port>", "port", (v) => Number(v))
  .option("-H, --host <host>", "host")
  .action(async (opts: { port?: number; host?: string }) => {
    const store = getConfigStore();
    const cfg0 = store.get();
    const shield = applyProxyShield(
      proxyModeFromShield(isGlobalProxyShieldOn(cfg0.server)),
    );
    const running = await startServer({
      store,
      port: opts.port,
      host: opts.host,
    });
    const cfg = store.get();
    const publicBase = gatewayBaseUrl(running.host, running.port);
    console.log(`GrokBuild Gateway listening on ${publicBase}`);
    console.log(`  Web UI     ${publicBase}/`);
    console.log(`  OpenAI API ${publicBase}/v1`);
    console.log(`  Control    ${publicBase}/api`);
    console.log(`  Config     ${store.path}`);
    console.log(`  Data       ${store.gbgHome}`);
    console.log(`  Active     ${cfg.activeProviderId}`);
    console.log(
      `  Proxy      global=${isGlobalProxyShieldOn(cfg.server) ? "on" : "off"}` +
        ` mode=${shield.mode}` +
        (shield.strippedProxyKeys.length
          ? ` (stripped ${shield.strippedProxyKeys.join(",")})`
          : "") +
        `; NO_PROXY loopback protected`,
    );
    console.log("");
    console.log("Point Grok Build at the gateway (restart Grok once):");
    console.log(buildGrokBootstrapSnippet(cfg));

    const shutdown = async () => {
      console.log("\nShutting down…");
      await store.stopWatch();
      await running.close();
      process.exit(0);
    };
    process.on("SIGINT", () => void shutdown());
    process.on("SIGTERM", () => void shutdown());
  });

program
  .command("status")
  .description("Show active provider, maps, and server health")
  .action(async () => {
    const store = getConfigStore();
    const cfg = store.get();
    let active: string;
    try {
      const p = getActiveProvider(cfg);
      active = `${p.id} (${p.name}) → ${p.baseUrl}`;
    } catch (err) {
      active = err instanceof Error ? err.message : String(err);
    }
    const live = await isServerRunning();
    console.log(`Config:   ${store.path}`);
    console.log(
      `Server:   ${live ? "running" : "stopped"} @ ${gatewayBaseUrl(cfg.server.host, cfg.server.port)}`,
    );
    console.log(`Active:   ${active}`);
    console.log(`Maps:     ${cfg.modelMaps.length}`);
    for (const m of cfg.modelMaps) {
      const pin = m.providerId ? ` @${m.providerId}` : "";
      const chain =
        m.candidates && m.candidates.length > 1
          ? ` [${m.candidates
              .filter((c) => c.enabled !== false)
              .map((c) => `${c.providerId || "active"}:${c.model}`)
              .join(" | ")}]`
          : "";
      console.log(`  ${m.from} → ${m.to}${pin}${chain}`);
    }
    console.log(`Virtual:  ${cfg.virtualModels.map((m) => m.id).join(", ") || "(none)"}`);
    if (live) {
      const health = await tryLocalApi<{
        version?: string;
        activeProviderId?: string;
      }>("/api/health");
      if (health.ok) {
        console.log(`Live API: v${health.data.version ?? "?"} active=${health.data.activeProviderId}`);
      }
    }
  });

const provider = program.command("provider").description("Manage providers");

provider
  .command("list")
  .description("List providers")
  .action(() => {
    const cfg = getConfigStore().get();
    for (const p of cfg.providers) {
      const mark = p.id === cfg.activeProviderId ? "*" : " ";
      const en = p.enabled ? "" : " [disabled]";
      console.log(
        `${mark} ${p.id.padEnd(16)} ${(p.apiBackend ?? "responses").padEnd(18)} ${p.name.padEnd(18)} ${p.baseUrl}  key=${maskSecret(p.apiKey)}${en}`,
      );
    }
  });

provider
  .command("use")
  .description("Switch active provider (hot if server running)")
  .argument("<id>", "provider id")
  .action(async (id: string) => {
    const store = getConfigStore();
    const live = await isServerRunning();
    if (live) {
      const r = await tryLocalApi<{ ok?: boolean; error?: string }>(
        "/api/active-provider",
        { method: "POST", body: JSON.stringify({ id }) },
      );
      if (!r.ok) {
        console.error(`Failed via live API: ${r.error}`);
        process.exitCode = 1;
        return;
      }
      console.log(`Active provider → ${id} (live)`);
      return;
    }
    try {
      store.setActiveProvider(id);
      console.log(`Active provider → ${id} (config saved; start server to serve traffic)`);
    } catch (err) {
      console.error(err instanceof Error ? err.message : err);
      process.exitCode = 1;
    }
  });

provider
  .command("add")
  .description("Add a provider")
  .requiredOption("--id <id>", "id")
  .requiredOption("--name <name>", "display name")
  .requiredOption("--base-url <url>", "base URL ending in /v1")
  .option("--api-key <key>", "api key or env:VAR", "env:XAI_API_KEY")
  .option(
    "--backend <backend>",
    "chat_completions | responses | messages",
    "responses",
  )
  .action((opts: {
    id: string;
    name: string;
    baseUrl: string;
    apiKey: string;
    backend: string;
  }) => {
    try {
      const extraHeaders: Record<string, string> = {};
      if (opts.backend === "messages") {
        extraHeaders["anthropic-version"] = "2023-06-01";
      }
      const p = ProviderSchema.parse({
        id: opts.id,
        name: opts.name,
        baseUrl: opts.baseUrl,
        apiKey: opts.apiKey,
        apiBackend: opts.backend as Provider["apiBackend"],
        enabled: true,
        extraHeaders,
      });
      getConfigStore().upsertProvider(p);
      console.log(`Added provider ${p.id} (backend=${p.apiBackend})`);
    } catch (err) {
      console.error(err instanceof Error ? err.message : err);
      process.exitCode = 1;
    }
  });

provider
  .command("remove")
  .description("Remove a provider")
  .argument("<id>", "provider id")
  .action((id: string) => {
    try {
      getConfigStore().removeProvider(id);
      console.log(`Removed ${id}`);
    } catch (err) {
      console.error(err instanceof Error ? err.message : err);
      process.exitCode = 1;
    }
  });

provider
  .command("test")
  .description("Probe provider /models")
  .argument("[id]", "provider id (default: active)")
  .action(async (id?: string) => {
    const live = await isServerRunning();
    if (live) {
      const r = await tryLocalApi<{
        ok?: boolean;
        status?: number;
        latencyMs?: number;
        sampleModels?: string[];
        error?: string;
        modelsUrl?: string;
      }>("/api/test-provider", {
        method: "POST",
        body: JSON.stringify(id ? { id } : {}),
      });
      if (!r.ok) {
        console.error(r.error);
        process.exitCode = 1;
        return;
      }
      console.log(JSON.stringify(r.data, null, 2));
      if (!r.data.ok) process.exitCode = 1;
      return;
    }
    // offline probe
    const cfg = getConfigStore().get();
    const pid = id ?? cfg.activeProviderId;
    const p = cfg.providers.find((x) => x.id === pid);
    if (!p) {
      console.error(`Provider not found: ${pid}`);
      process.exitCode = 1;
      return;
    }
    const key = resolveSecret(p.apiKey);
    if (!key) {
      console.error(`No API key resolved for ${pid}`);
      process.exitCode = 1;
      return;
    }
    const url = p.modelsListUrl ?? `${p.baseUrl.replace(/\/+$/, "")}/models`;
    try {
      const forceDirect = isProviderProxyShieldOn(cfg.server, p);
      const resp = await upstreamFetch(url, {
        headers: { authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(15_000),
        forceDirect,
      });
      console.log(`GET ${url} → ${resp.status}`);
      const text = await resp.text();
      console.log(text.slice(0, 500));
      if (!resp.ok) process.exitCode = 1;
    } catch (err) {
      console.error(err instanceof Error ? err.message : err);
      process.exitCode = 1;
    }
  });

const mapCmd = program.command("map").description("Manage model maps");

mapCmd
  .command("list")
  .description("List model maps")
  .action(() => {
    const maps = getConfigStore().get().modelMaps;
    if (maps.length === 0) {
      console.log("(no maps)");
      return;
    }
    for (const m of maps) {
      const pin = m.providerId ? ` provider=${m.providerId}` : "";
      const chain =
        m.candidates && m.candidates.length
          ? ` candidates=${m.candidates
              .map(
                (c) =>
                  `${c.enabled === false ? "!" : ""}${c.providerId || "active"}:${c.model}`,
              )
              .join(",")}`
          : "";
      console.log(`${m.from} → ${m.to}${pin}${chain}`);
    }
  });

mapCmd
  .command("set")
  .description("Set model map from → to (optional multi-channel candidates)")
  .argument("<from>", "inbound model id (what Grok sends)")
  .argument("<to>", "upstream model id (primary)")
  .option("--provider <id>", "pin primary provider")
  .option(
    "--candidates <list>",
    "ordered candidates as provider:model,provider:model (empty provider = active)",
  )
  .action(
    async (
      from: string,
      to: string,
      opts: { provider?: string; candidates?: string },
    ) => {
    const store = getConfigStore();
    const candidates = (opts.candidates ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((part) => {
        const idx = part.indexOf(":");
        if (idx === -1) {
          return {
            providerId: opts.provider ?? "",
            model: part,
            enabled: true,
          };
        }
        return {
          providerId: part.slice(0, idx).trim(),
          model: part.slice(idx + 1).trim(),
          enabled: true,
        };
      });
    const entry = {
      from,
      to,
      providerId: opts.provider ?? null,
      candidates,
    };
    const live = await isServerRunning();
    if (live) {
      const r = await tryLocalApi("/api/model-maps", {
        method: "POST",
        body: JSON.stringify(entry),
      });
      if (!r.ok) {
        console.error(r.error);
        process.exitCode = 1;
        return;
      }
      console.log(`Map ${from} → ${to} (live)`);
      return;
    }
    store.update((cfg) => {
      cfg.modelMaps = upsertModelMap(cfg.modelMaps, entry);
      return cfg;
    });
    console.log(`Map ${from} → ${to}`);
  },
  );

mapCmd
  .command("remove")
  .description("Remove a model map")
  .argument("<from>", "inbound model id")
  .action(async (from: string) => {
    const store = getConfigStore();
    const live = await isServerRunning();
    if (live) {
      const r = await tryLocalApi(
        `/api/model-maps/${encodeURIComponent(from)}`,
        { method: "DELETE" },
      );
      if (!r.ok) {
        console.error(r.error);
        process.exitCode = 1;
        return;
      }
      console.log(`Removed map ${from} (live)`);
      return;
    }
    store.update((cfg) => {
      cfg.modelMaps = removeModelMap(cfg.modelMaps, from);
      return cfg;
    });
    console.log(`Removed map ${from}`);
  });

program
  .command("models")
  .description("List virtual models exposed at /v1/models")
  .action(() => {
    const models = getConfigStore().get().virtualModels;
    for (const m of models) {
      console.log(
        `${m.id.padEnd(20)} ${m.name}${m.contextWindow ? `  ctx=${m.contextWindow}` : ""}`,
      );
    }
  });

program
  .command("fetch-models")
  .description("List models from an upstream provider (no write)")
  .argument("[providerId]", "provider id (default: active)")
  .action(async (providerId?: string) => {
    const live = await isServerRunning();
    if (live) {
      const r = await tryLocalApi<{
        ok?: boolean;
        models?: Array<{ id: string; name?: string; contextWindow?: number }>;
        error?: string;
        modelsUrl?: string;
      }>("/api/fetch-models", {
        method: "POST",
        body: JSON.stringify(providerId ? { id: providerId } : {}),
      });
      if (!r.ok) {
        console.error(r.error);
        process.exitCode = 1;
        return;
      }
      const data = r.data;
      if (!data.ok) {
        console.error(data.error || "fetch failed");
        process.exitCode = 1;
        return;
      }
      console.log(`URL: ${data.modelsUrl}`);
      for (const m of data.models ?? []) {
        console.log(
          `${m.id.padEnd(40)} ${(m.name || "").padEnd(24)} ${m.contextWindow ?? ""}`,
        );
      }
      console.log(`Total: ${(data.models ?? []).length}`);
      return;
    }

    const store = getConfigStore();
    const cfg = store.get();
    const id = providerId ?? cfg.activeProviderId;
    const provider = cfg.providers.find((p) => p.id === id);
    if (!provider) {
      console.error(`Provider not found: ${id}`);
      process.exitCode = 1;
      return;
    }
    const result = await fetchUpstreamModels(provider, { server: cfg.server });
    if (!result.ok) {
      console.error(result.error || "fetch failed");
      process.exitCode = 1;
      return;
    }
    console.log(`URL: ${result.modelsUrl}`);
    for (const m of result.models) {
      console.log(
        `${m.id.padEnd(40)} ${(m.name || "").padEnd(24)} ${m.contextWindow ?? ""}`,
      );
    }
    console.log(`Total: ${result.models.length}`);
  });

program
  .command("import-models")
  .description(
    "Pull upstream models into virtual models and/or identity maps",
  )
  .argument("[providerId]", "provider id (default: active)")
  .option("--mode <mode>", "merge | replace", "merge")
  .option(
    "--target <target>",
    "virtual | maps | both",
    "both",
  )
  .option("--pin-provider", "pin model maps to this provider", false)
  .action(
    async (
      providerId: string | undefined,
      opts: { mode: string; target: string; pinProvider?: boolean },
    ) => {
      const mode = opts.mode === "replace" ? "replace" : "merge";
      const target =
        opts.target === "virtual" || opts.target === "maps"
          ? opts.target
          : "both";
      const live = await isServerRunning();
      if (live) {
        const r = await tryLocalApi<{
          ok?: boolean;
          imported?: number;
          error?: string;
        }>("/api/import-models", {
          method: "POST",
          body: JSON.stringify({
            id: providerId,
            mode,
            target,
            pinProvider: Boolean(opts.pinProvider),
          }),
        });
        if (!r.ok) {
          console.error(r.error);
          process.exitCode = 1;
          return;
        }
        if (!r.data.ok) {
          console.error(r.data.error || "import failed");
          process.exitCode = 1;
          return;
        }
        console.log(
          `Imported ${r.data.imported ?? 0} models (${mode}, ${target})${live ? " [live]" : ""}`,
        );
        return;
      }

      const store = getConfigStore();
      const cfg = store.get();
      const id = providerId ?? cfg.activeProviderId;
      const provider = cfg.providers.find((p) => p.id === id);
      if (!provider) {
        console.error(`Provider not found: ${id}`);
        process.exitCode = 1;
        return;
      }
      const result = await fetchUpstreamModels(provider, { server: cfg.server });
      if (!result.ok) {
        console.error(result.error || "fetch failed");
        process.exitCode = 1;
        return;
      }
      const virtualIncoming = upstreamToVirtualModels(result.models, {
        ownedBy: provider.id,
      });
      const mapIncoming = buildIdentityMaps(result.models, {
        providerId: opts.pinProvider ? provider.id : null,
      });
      store.update((draft) => {
        if (target === "virtual" || target === "both") {
          draft.virtualModels = mergeVirtualModels(
            draft.virtualModels,
            virtualIncoming,
            mode,
          );
        }
        if (target === "maps" || target === "both") {
          draft.modelMaps = mergeModelMaps(
            draft.modelMaps,
            mapIncoming,
            mode,
          );
        }
        return draft;
      });
      console.log(
        `Imported ${result.models.length} models from ${provider.id} (${mode}, ${target})`,
      );
    },
  );

program
  .command("bootstrap")
  .description("Print Grok config.toml snippet pointing at this gateway")
  .action(() => {
    const cfg = getConfigStore().get();
    console.log(buildGrokBootstrapSnippet(cfg));
    console.log(
      `# Preview only. One-click write: gbg apply-grok\n# Target: ${getGrokConfigPath()}`,
    );
  });

program
  .command("apply-grok")
  .description(
    "Backup and patch ~/.grok/config.toml to point at this gateway",
  )
  .option("-y, --yes", "skip confirmation prompt", false)
  .action(async (opts: { yes?: boolean }) => {
    const store = getConfigStore();
    const cfg = store.get();
    const path = getGrokConfigPath();
    console.log(`Target: ${path}`);
    console.log(`Gateway: ${gatewayBaseUrl(cfg.server.host, cfg.server.port)}/v1`);
    console.log("");
    console.log(buildGrokBootstrapSnippet(cfg));

    if (!opts.yes) {
      // Non-interactive environments: require --yes
      if (!process.stdin.isTTY) {
        console.error("Refusing to write without --yes in non-TTY mode.");
        process.exitCode = 1;
        return;
      }
      const readline = await import("node:readline/promises");
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
      });
      const answer = await rl.question(
        "Write this into Grok config.toml (backup first)? [y/N] ",
      );
      rl.close();
      if (!/^y(es)?$/i.test(answer.trim())) {
        console.log("Cancelled.");
        return;
      }
    }

    const live = await isServerRunning();
    if (live) {
      const r = await tryLocalApi<{
        ok?: boolean;
        message?: string;
        backupPath?: string | null;
        path?: string;
        error?: string;
      }>("/api/apply-grok", { method: "POST", body: "{}" });
      if (!r.ok) {
        console.error(r.error);
        process.exitCode = 1;
        return;
      }
      if (!r.data.ok) {
        console.error(r.data.error || "apply failed");
        process.exitCode = 1;
        return;
      }
      console.log(r.data.message || "Applied.");
      if (r.data.backupPath) console.log(`Backup: ${r.data.backupPath}`);
      console.log("Restart Grok once for base_url changes to take effect.");
      return;
    }

    try {
      const result = applyGrokConfig(cfg);
      console.log(result.message);
      if (result.backupPath) console.log(`Backup: ${result.backupPath}`);
      console.log("Restart Grok once for base_url changes to take effect.");
    } catch (err) {
      console.error(err instanceof Error ? err.message : err);
      process.exitCode = 1;
    }
  });

program
  .command("doctor")
  .description("Check config, keys, port, proxy shield, and Grok wiring")
  .option("--fix-proxy", "merge 127.0.0.1,localhost,::1 into user NO_PROXY (Windows/User env)")
  .action(async (opts: { fixProxy?: boolean }) => {
    const store = getConfigStore();
    const cfg = store.get();
    applyProxyShield(proxyModeFromShield(isGlobalProxyShieldOn(cfg.server)));
    const issues: string[] = [];
    const ok: string[] = [];
    const warns: string[] = [];

    ok.push(`config: ${store.path}`);
    ok.push(
      `proxyShield global: ${isGlobalProxyShieldOn(cfg.server) ? "on" : "off"}` +
        ` (mode=${cfg.server.proxyMode ?? "direct"})`,
    );

    try {
      const p = getActiveProvider(cfg);
      ok.push(`active provider: ${p.id} (${p.baseUrl})`);
      const key = resolveSecret(p.apiKey);
      if (!key) issues.push(`active provider key not resolved (${p.apiKey || "empty"})`);
      else ok.push(`active provider key: ${maskSecret(p.apiKey)} resolved`);
    } catch (err) {
      issues.push(err instanceof Error ? err.message : String(err));
    }

    for (const p of cfg.providers) {
      if (!p.enabled) continue;
      const key = resolveSecret(p.apiKey);
      if (!key) issues.push(`provider ${p.id}: key not resolved (${p.apiKey || "empty"})`);
    }

    const publicBase = gatewayBaseUrl(cfg.server.host, cfg.server.port);
    const live = await isServerRunning();
    if (live) ok.push(`gateway: running at ${publicBase}`);
    else issues.push(`gateway not running — start with: gbg serve`);

    // Proxy shield diagnostics (saved env + current)
    const shield = getProxyShieldState();
    for (const f of diagnoseProxyEnv(process.env, shield)) {
      if (f.level === "error") issues.push(`[proxy] ${f.message}`);
      else if (f.level === "warn") warns.push(`[proxy] ${f.message}`);
      else ok.push(`[proxy] ${f.message}`);
    }

    if (opts.fixProxy) {
      try {
        const { fixUserNoProxy } = await import("./lib/fix-user-noproxy.js");
        const r = fixUserNoProxy();
        ok.push(`[proxy] fix-user-noproxy: ${r.message}`);
      } catch (err) {
        issues.push(
          `[proxy] fix-user-noproxy failed: ${err instanceof Error ? err.message : err}`,
        );
      }
    } else if (warns.some((w) => w.includes("NO_PROXY"))) {
      warns.push(
        "[proxy] Tip: re-run with `gbg doctor --fix-proxy` to merge loopback into user NO_PROXY, " +
          "or enable Windows “Don’t use proxy for local addresses”.",
      );
    }

    const grokPath = getGrokConfigPath();
    if (!existsSync(grokPath)) {
      issues.push(`Grok config missing: ${grokPath}`);
    } else {
      const text = readFileSync(grokPath, "utf8");
      const expected = publicBase;
      const hasLoopback =
        text.includes(expected) ||
        text.includes(`127.0.0.1:${cfg.server.port}`) ||
        text.includes("127.0.0.1:8787");
      const hasLocalhostOnly =
        !hasLoopback &&
        (text.includes(`localhost:${cfg.server.port}`) ||
          text.includes("localhost:8787"));
      if (hasLoopback) {
        ok.push(`Grok config points at gateway via 127.0.0.1 (${expected})`);
      } else if (hasLocalhostOnly) {
        warns.push(
          `Grok config uses localhost instead of 127.0.0.1 — system proxy may break it. Run: gbg apply-grok --yes`,
        );
      } else {
        issues.push(
          `Grok config does not mention gateway ${expected} — run: gbg apply-grok`,
        );
      }
    }

    console.log("OK:");
    for (const line of ok) console.log(`  ✓ ${line}`);
    if (warns.length) {
      console.log("Warnings:");
      for (const line of warns) console.log(`  ! ${line}`);
    }
    if (issues.length) {
      console.log("Issues:");
      for (const line of issues) console.log(`  ✗ ${line}`);
      process.exitCode = 1;
    } else {
      console.log("All checks passed.");
    }
  });

program
  .command("config")
  .description("Config path / reset / restore")
  .action(() => {
    const store = getConfigStore();
    console.log(`Data home : ${store.gbgHome}`);
    console.log(`Config    : ${store.path}`);
    const backups = store.listBackups();
    if (!backups.length) console.log("Backups   : (none)");
    else {
      console.log("Backups   :");
      for (const b of backups.slice(0, 10)) {
        console.log(`  ${b.name}`);
      }
    }
  });

program
  .command("reset-config")
  .description("Restore default config (backs up current first)")
  .option("--yes", "skip confirmation", false)
  .option("--from-backup [name]", "restore from a backup instead of defaults")
  .action(async (opts: { yes?: boolean; fromBackup?: string | true }) => {
    const live = await isServerRunning();
    const mode =
      opts.fromBackup === undefined ? "defaults" : "backup";
    const backup =
      typeof opts.fromBackup === "string" ? opts.fromBackup : undefined;

    if (!opts.yes) {
      const label =
        mode === "defaults"
          ? "Reset config to factory defaults?"
          : `Restore config from backup${backup ? ` (${backup})` : " (latest)"}?`;
      process.stdout.write(`${label} [y/N] `);
      const answer = await new Promise<string>((resolve) => {
        process.stdin.setEncoding("utf8");
        process.stdin.once("data", (d) => resolve(String(d).trim()));
      });
      if (answer.toLowerCase() !== "y" && answer.toLowerCase() !== "yes") {
        console.log("Cancelled.");
        return;
      }
    }

    if (live) {
      const r = await tryLocalApi<{
        ok?: boolean;
        message?: string;
        backupPath?: string | null;
        restoredFrom?: string | null;
        error?: string;
      }>("/api/config/reset", {
        method: "POST",
        body: JSON.stringify({ mode, backup }),
      });
      if (!r.ok) {
        console.error(r.error || "reset failed");
        process.exitCode = 1;
        return;
      }
      console.log(r.data.message || "ok");
      if (r.data.backupPath) console.log(`Previous backup: ${r.data.backupPath}`);
      if (r.data.restoredFrom) console.log(`Restored from: ${r.data.restoredFrom}`);
      return;
    }

    const store = getConfigStore();
    try {
      const result =
        mode === "backup"
          ? store.restoreFromBackup(backup)
          : store.resetToDefaults();
      console.log(
        result.mode === "defaults"
          ? "Restored factory defaults."
          : `Restored from ${result.restoredFrom}`,
      );
      if (result.backupPath) console.log(`Previous backup: ${result.backupPath}`);
    } catch (err) {
      console.error(err instanceof Error ? err.message : err);
      process.exitCode = 1;
    }
  });

program
  .command("failover")
  .description("Show failover config and provider cooldown health")
  .action(async () => {
    const live = await tryLocalApi<{
      failover?: Record<string, unknown>;
      providerHealth?: Array<Record<string, unknown>>;
    }>("/api/failover");
    if (live.ok) {
      console.log("Failover:", JSON.stringify(live.data.failover ?? {}, null, 2));
      console.log("Health:", JSON.stringify(live.data.providerHealth ?? [], null, 2));
      return;
    }
    const cfg = getConfigStore().get();
    console.log("Failover:", JSON.stringify(cfg.server.failover ?? {}, null, 2));
    console.log("(start server for live provider health)");
  });

void program.parseAsync(process.argv);
