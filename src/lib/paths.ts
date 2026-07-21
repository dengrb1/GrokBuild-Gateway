import { homedir } from "node:os";
import { join } from "node:path";

export function getGbgHome(): string {
  if (process.env.GBG_HOME?.trim()) {
    return process.env.GBG_HOME.trim();
  }
  return join(homedir(), ".gbg");
}

export function getConfigPath(home = getGbgHome()): string {
  return join(home, "config.json");
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
