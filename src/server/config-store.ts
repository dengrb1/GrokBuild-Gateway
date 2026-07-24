import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  watch as fsWatch,
  writeFileSync,
  type FSWatcher,
} from "node:fs";
import { dirname, join } from "node:path";
import {
  createDefaultConfig,
  GbgConfigSchema,
  normalizeModelMap,
  type GbgConfig,
  type ModelMap,
  type Provider,
  type VirtualModel,
} from "./types.js";
import {
  getBackupDir,
  getConfigPath,
  getGbgHome,
  migrateLegacyConfigIfNeeded,
} from "../lib/paths.js";
import { maskSecret } from "../lib/secrets.js";
import { cloneJson } from "../lib/clone.js";

type Listener = (config: GbgConfig) => void;

export interface ConfigBackupInfo {
  name: string;
  path: string;
  mtimeMs: number;
}

export interface ResetConfigResult {
  config: GbgConfig;
  backupPath: string | null;
  mode: "defaults" | "backup";
  restoredFrom?: string;
}

function stamp(): string {
  return new Date()
    .toISOString()
    .replaceAll(":", "")
    .replaceAll(".", "")
    .replace("T", "_")
    .slice(0, 15);
}

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
  private migratedFromLegacy: string | null = null;

  constructor(options?: { home?: string; configPath?: string }) {
    this.home = options?.home ?? getGbgHome();
    this.configPath = options?.configPath ?? getConfigPath(this.home);
    // Only migrate for the default app home (never for explicit test homes).
    if (!options?.home && !options?.configPath) {
      const mig = migrateLegacyConfigIfNeeded(this.home);
      if (mig.migrated) this.migratedFromLegacy = mig.from;
    }
    this.config = this.loadOrCreate();
  }

  get path(): string {
    return this.configPath;
  }

  get gbgHome(): string {
    return this.home;
  }

  get legacyMigrationSource(): string | null {
    return this.migratedFromLegacy;
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
        void this.rearmWatch();
      });
    } catch {
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
      cfg.modelMaps = cfg.modelMaps.map((m) => {
        const next = {
          ...m,
          providerId: m.providerId === id ? null : m.providerId,
          candidates: (m.candidates ?? []).map((c) =>
            c.providerId === id ? { ...c, providerId: "" } : c,
          ),
        };
        return normalizeModelMap(next);
      });
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

  /** Snapshot current config.json into data/backups/. */
  backupCurrent(label = "config"): string | null {
    if (!existsSync(this.configPath)) return null;
    const dir = getBackupDir(this.home);
    mkdirSync(dir, { recursive: true });
    const dest = join(dir, `${label}.${stamp()}.json`);
    copyFileSync(this.configPath, dest);
    return dest;
  }

  listBackups(): ConfigBackupInfo[] {
    const dir = getBackupDir(this.home);
    if (!existsSync(dir)) return [];
    const out: ConfigBackupInfo[] = [];
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".json")) continue;
      const path = join(dir, name);
      try {
        out.push({
          name,
          path,
          mtimeMs: statSync(path).mtimeMs,
        });
      } catch {
        // skip unreadable
      }
    }
    return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  }

  /**
   * Restore factory defaults. Current config is backed up first.
   */
  resetToDefaults(): ResetConfigResult {
    const backupPath = this.backupCurrent("before-reset");
    const defaults = createDefaultConfig();
    this.config = defaults;
    this.persist();
    this.bump();
    this.emit();
    return { config: this.config, backupPath, mode: "defaults" };
  }

  /**
   * Restore from a backup file (name or absolute path under backups/).
   * Current config is backed up first.
   */
  restoreFromBackup(nameOrPath?: string): ResetConfigResult {
    const backups = this.listBackups();
    if (!backups.length) {
      throw new Error("No config backups found under data/backups");
    }
    let target = backups[0]!;
    if (nameOrPath?.trim()) {
      const key = nameOrPath.trim();
      const found = backups.find(
        (b) => b.name === key || b.path === key || b.path.endsWith(key),
      );
      if (!found) {
        throw new Error(`Backup not found: ${key}`);
      }
      target = found;
    }

    const backupPath = this.backupCurrent("before-restore");
    const raw = readFileSync(target.path, "utf8");
    const parsed = GbgConfigSchema.parse(JSON.parse(raw));
    this.validateRefs(parsed);
    this.config = parsed;
    this.persist();
    this.bump();
    this.emit();
    return {
      config: this.config,
      backupPath,
      mode: "backup",
      restoredFrom: target.path,
    };
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
      for (const c of m.candidates ?? []) {
        if (
          c.providerId &&
          !cfg.providers.some((p) => p.id === c.providerId)
        ) {
          throw new Error(
            `model map "${m.from}" candidate references unknown provider "${c.providerId}"`,
          );
        }
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
