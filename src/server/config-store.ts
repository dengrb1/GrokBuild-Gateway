import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  watch as fsWatch,
  writeFileSync,
  type FSWatcher,
} from "node:fs";
import { dirname } from "node:path";
import {
  createDefaultConfig,
  GbgConfigSchema,
  type GbgConfig,
  type ModelMap,
  type Provider,
  type VirtualModel,
} from "./types.js";
import { getConfigPath, getGbgHome } from "../lib/paths.js";
import { maskSecret } from "../lib/secrets.js";
import { cloneJson } from "../lib/clone.js";

type Listener = (config: GbgConfig) => void;

export class ConfigStore {
  private config: GbgConfig;
  private readonly configPath: string;
  private readonly home: string;
  private listeners = new Set<Listener>();
  private watcher: FSWatcher | null = null;
  private writing = false;
  private reloadTimer: ReturnType<typeof setTimeout> | null = null;
  private rev = 1;
  private redactedCache: GbgConfig | null = null;
  private redactedRev = 0;

  constructor(options?: { home?: string; configPath?: string }) {
    this.home = options?.home ?? getGbgHome();
    this.configPath = options?.configPath ?? getConfigPath(this.home);
    this.config = this.loadOrCreate();
  }

  get path(): string {
    return this.configPath;
  }

  get gbgHome(): string {
    return this.home;
  }

  /** Monotonic revision — UI can skip re-render when unchanged. */
  get revision(): number {
    return this.rev;
  }

  get(): GbgConfig {
    return this.config;
  }

  /** Deep snapshot safe for mutation by callers. */
  snapshot(): GbgConfig {
    return cloneJson(this.config);
  }

  onChange(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Native fs.watch — no chokidar (saves dependency + polling workers).
   * Debounced; ignores our own atomic writes.
   */
  startWatch(): void {
    if (this.watcher) return;
    try {
      mkdirSync(dirname(this.configPath), { recursive: true });
      this.watcher = fsWatch(this.configPath, () => this.scheduleReload());
      this.watcher.on("error", () => {
        // file may have been replaced on Windows — re-arm
        void this.rearmWatch();
      });
    } catch {
      // config may not exist yet; try parent dir
      try {
        const dir = dirname(this.configPath);
        mkdirSync(dir, { recursive: true });
        this.watcher = fsWatch(dir, (_event, filename) => {
          if (!filename || String(filename).includes("config.json")) {
            this.scheduleReload();
          }
        });
      } catch (err) {
        console.error("[gbg] config watch unavailable:", err);
      }
    }
  }

  private async rearmWatch(): Promise<void> {
    await this.stopWatch();
    this.startWatch();
  }

  async stopWatch(): Promise<void> {
    if (this.reloadTimer) {
      clearTimeout(this.reloadTimer);
      this.reloadTimer = null;
    }
    if (this.watcher) {
      try {
        this.watcher.close();
      } catch {
        // ignore
      }
      this.watcher = null;
    }
  }

  private scheduleReload(): void {
    if (this.writing) return;
    if (this.reloadTimer) clearTimeout(this.reloadTimer);
    this.reloadTimer = setTimeout(() => {
      this.reloadTimer = null;
      if (this.writing) return;
      try {
        this.reloadFromDisk();
      } catch (err) {
        console.error("[gbg] failed to reload config:", err);
      }
    }, 80);
  }

  reloadFromDisk(): GbgConfig {
    if (!existsSync(this.configPath)) {
      return this.config;
    }
    const raw = readFileSync(this.configPath, "utf8");
    const parsed = GbgConfigSchema.parse(JSON.parse(raw));
    // skip no-op reloads (same content)
    if (JSON.stringify(parsed) === JSON.stringify(this.config)) {
      return this.config;
    }
    this.config = parsed;
    this.bump();
    this.emit();
    return this.config;
  }

  replace(next: GbgConfig): GbgConfig {
    const parsed = GbgConfigSchema.parse(next);
    this.validateRefs(parsed);
    this.config = parsed;
    this.persist();
    this.bump();
    this.emit();
    return this.config;
  }

  update(mutator: (cfg: GbgConfig) => GbgConfig): GbgConfig {
    const draft = cloneJson(this.config);
    const next = mutator(draft);
    return this.replace(next);
  }

  setActiveProvider(id: string): GbgConfig {
    return this.update((cfg) => {
      const p = cfg.providers.find((x) => x.id === id);
      if (!p) throw new Error(`Provider not found: ${id}`);
      if (!p.enabled) throw new Error(`Provider is disabled: ${id}`);
      cfg.activeProviderId = id;
      return cfg;
    });
  }

  upsertProvider(provider: Provider): GbgConfig {
    return this.update((cfg) => {
      const idx = cfg.providers.findIndex((p) => p.id === provider.id);
      if (idx === -1) cfg.providers.push(provider);
      else cfg.providers[idx] = provider;
      return cfg;
    });
  }

  removeProvider(id: string): GbgConfig {
    return this.update((cfg) => {
      if (cfg.providers.length <= 1) {
        throw new Error("Cannot remove the last provider");
      }
      if (cfg.activeProviderId === id) {
        throw new Error(
          "Cannot remove the active provider; switch first with `gbg provider use`",
        );
      }
      cfg.providers = cfg.providers.filter((p) => p.id !== id);
      cfg.modelMaps = cfg.modelMaps.map((m) =>
        m.providerId === id ? { ...m, providerId: null } : m,
      );
      return cfg;
    });
  }

  setModelMaps(maps: ModelMap[]): GbgConfig {
    return this.update((cfg) => {
      cfg.modelMaps = maps;
      return cfg;
    });
  }

  setVirtualModels(models: VirtualModel[]): GbgConfig {
    return this.update((cfg) => {
      cfg.virtualModels = models;
      return cfg;
    });
  }

  /** Config for API/UI — secrets masked. Cached per revision. */
  redact(): GbgConfig {
    if (this.redactedCache && this.redactedRev === this.rev) {
      return this.redactedCache;
    }
    const snap = cloneJson(this.config);
    for (const p of snap.providers) {
      p.apiKey = maskSecret(p.apiKey);
    }
    if (snap.server.gatewayToken) {
      snap.server.gatewayToken = maskSecret(snap.server.gatewayToken);
    }
    this.redactedCache = snap;
    this.redactedRev = this.rev;
    return snap;
  }

  private bump(): void {
    this.rev += 1;
    this.redactedCache = null;
  }

  private loadOrCreate(): GbgConfig {
    mkdirSync(this.home, { recursive: true });
    if (!existsSync(this.configPath)) {
      const defaults = createDefaultConfig();
      this.writeAtomic(defaults);
      return defaults;
    }
    try {
      const raw = readFileSync(this.configPath, "utf8");
      return GbgConfigSchema.parse(JSON.parse(raw));
    } catch (err) {
      console.error(
        `[gbg] invalid config at ${this.configPath}, using defaults:`,
        err,
      );
      return createDefaultConfig();
    }
  }

  private validateRefs(cfg: GbgConfig): void {
    if (!cfg.providers.some((p) => p.id === cfg.activeProviderId)) {
      throw new Error(
        `activeProviderId "${cfg.activeProviderId}" not in providers list`,
      );
    }
    for (const m of cfg.modelMaps) {
      if (m.providerId && !cfg.providers.some((p) => p.id === m.providerId)) {
        throw new Error(
          `model map "${m.from}" references unknown provider "${m.providerId}"`,
        );
      }
    }
  }

  private persist(): void {
    this.writeAtomic(this.config);
  }

  private writeAtomic(cfg: GbgConfig): void {
    mkdirSync(dirname(this.configPath), { recursive: true });
    const tmp = `${this.configPath}.${process.pid}.tmp`;
    this.writing = true;
    try {
      writeFileSync(tmp, `${JSON.stringify(cfg, null, 2)}\n`, "utf8");
      renameSync(tmp, this.configPath);
    } finally {
      // ignore fs.watch events from our own write briefly
      setTimeout(() => {
        this.writing = false;
      }, 100);
    }
  }

  private emit(): void {
    for (const listener of this.listeners) {
      try {
        listener(this.config);
      } catch (err) {
        console.error("[gbg] config listener error:", err);
      }
    }
  }
}

let singleton: ConfigStore | null = null;

export function getConfigStore(options?: {
  home?: string;
  configPath?: string;
}): ConfigStore {
  if (options?.home || options?.configPath) {
    return new ConfigStore(options);
  }
  if (!singleton) singleton = new ConfigStore();
  return singleton;
}

export function resetConfigStoreSingleton(): void {
  singleton = null;
}
