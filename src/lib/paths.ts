import { copyFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

/**
 * Directory the process is "running from":
 * - GBG_ROOT override
 * - compiled gbg*.exe directory
 * - otherwise process.cwd()
 */
export function getRunDir(): string {
  if (process.env.GBG_ROOT?.trim()) {
    return process.env.GBG_ROOT.trim();
  }

  const exec = process.execPath;
  const base = basename(exec).toLowerCase();
  if (
    base === "gbg.exe" ||
    base === "gbg" ||
    base.startsWith("gbg-") ||
    base === "gbg-desktop.exe" ||
    base === "gbg-desktop-compat.exe"
  ) {
    return dirname(exec);
  }

  // Bun --compile: argv[1] may be empty; execPath is the binary.
  // Detect when the binary name contains gbg even under different casing.
  if (base.includes("gbg") && (base.endsWith(".exe") || !base.includes("."))) {
    // Avoid treating node/bun toolchain as app binary.
    if (!base.includes("node") && base !== "bun" && base !== "bun.exe") {
      return dirname(exec);
    }
  }

  return process.cwd();
}

/**
 * App data home for config/backups.
 * Default: <runDir>/data
 * Override: GBG_HOME
 */
export function getGbgHome(): string {
  if (process.env.GBG_HOME?.trim()) {
    return process.env.GBG_HOME.trim();
  }
  return join(getRunDir(), "data");
}

export function getConfigPath(home = getGbgHome()): string {
  return join(home, "config.json");
}

export function getBackupDir(home = getGbgHome()): string {
  return join(home, "backups");
}

/** Legacy location used by older builds (~/.gbg). */
export function getLegacyGbgHome(): string {
  return join(homedir(), ".gbg");
}

/**
 * If the new home has no config yet but ~/.gbg/config.json exists,
 * copy it once so upgrades keep user settings.
 */
export function migrateLegacyConfigIfNeeded(home = getGbgHome()): {
  migrated: boolean;
  from: string | null;
  to: string;
} {
  const to = getConfigPath(home);
  if (existsSync(to)) {
    return { migrated: false, from: null, to };
  }
  const from = getConfigPath(getLegacyGbgHome());
  if (!existsSync(from)) {
    return { migrated: false, from: null, to };
  }
  mkdirSync(home, { recursive: true });
  copyFileSync(from, to);

  // Best-effort: also bring over previous backups.
  const legacyBackups = getBackupDir(getLegacyGbgHome());
  const nextBackups = getBackupDir(home);
  if (existsSync(legacyBackups)) {
    try {
      mkdirSync(nextBackups, { recursive: true });
      for (const name of readdirSync(legacyBackups)) {
        const src = join(legacyBackups, name);
        const dst = join(nextBackups, name);
        if (!existsSync(dst)) {
          copyFileSync(src, dst);
        }
      }
    } catch {
      // ignore backup copy failures
    }
  }

  return { migrated: true, from, to };
}

export function getGrokHome(): string {
  if (process.env.GROK_HOME?.trim()) {
    return process.env.GROK_HOME.trim();
  }
  return join(homedir(), ".grok");
}

export function getGrokConfigPath(home = getGrokHome()): string {
  return join(home, "config.toml");
}
