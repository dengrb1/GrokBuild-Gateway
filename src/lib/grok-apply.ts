import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { GbgConfig, VirtualModel } from "../server/types.js";
import { getBackupDir, getGrokConfigPath } from "./paths.js";
import { buildGrokBootstrapSnippet } from "./bootstrap-snippet.js";
import { gatewayBaseUrl } from "./proxy-shield.js";

export interface ApplyGrokOptions {
  /** Write without interactive confirm (API/CLI --yes). */
  force?: boolean;
  /** Override path for tests. */
  grokConfigPath?: string;
  backupDir?: string;
}

export interface ApplyGrokResult {
  ok: boolean;
  path: string;
  backupPath: string | null;
  changed: boolean;
  message: string;
  snippet: string;
}

function escapeTomlKey(id: string): string {
  // Use quoted keys for ids with dots / special chars
  if (/^[A-Za-z0-9_-]+$/.test(id) && !id.includes(".")) return id;
  return `"${id.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function sectionHeaderForModel(id: string): string {
  return `[model.${escapeTomlKey(id)}]`;
}

/** Find [section] block ranges (start line inclusive, end exclusive). */
function findSectionRange(
  lines: string[],
  header: string,
): { start: number; end: number } | null {
  const headerNorm = header.trim();
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === headerNorm) {
      start = i;
      break;
    }
  }
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    const t = lines[i].trim();
    if (t.startsWith("[") && t.endsWith("]")) {
      end = i;
      break;
    }
  }
  return { start, end };
}

function upsertKeyInSection(
  lines: string[],
  range: { start: number; end: number },
  key: string,
  value: string,
): void {
  const keyRe = new RegExp(`^\\s*${key}\\s*=`);
  for (let i = range.start + 1; i < range.end; i++) {
    if (keyRe.test(lines[i])) {
      lines[i] = `${key} = ${value}`;
      return;
    }
  }
  // insert after header
  lines.splice(range.start + 1, 0, `${key} = ${value}`);
  range.end += 1;
}

function ensureSection(
  lines: string[],
  header: string,
): { start: number; end: number } {
  const existing = findSectionRange(lines, header);
  if (existing) return existing;
  if (lines.length && lines[lines.length - 1].trim() !== "") lines.push("");
  lines.push(header);
  return { start: lines.length - 1, end: lines.length };
}

function modelBlock(
  id: string,
  baseUrl: string,
  token: string,
  vm?: VirtualModel,
): string[] {
  const header = sectionHeaderForModel(id);
  const name = vm?.name || id;
  const ctx = vm?.contextWindow ?? 200000;
  return [
    header,
    `model = "${id}"`,
    `base_url = "${baseUrl}"`,
    `api_backend = "chat_completions"`,
    `name = "${name.replaceAll('"', '\\"')} (via GBG)"`,
    `api_key = "${token}"`,
    `context_window = ${ctx}`,
    `max_completion_tokens = 65536`,
  ];
}

/**
 * Patch ~/.grok/config.toml so Grok points at the local gateway.
 * Backs up the previous file under ~/.gbg/backups/.
 */
export function applyGrokConfig(
  cfg: GbgConfig,
  options: ApplyGrokOptions = {},
): ApplyGrokResult {
  const path = options.grokConfigPath ?? getGrokConfigPath();
  const baseUrl = `${gatewayBaseUrl(cfg.server.host, cfg.server.port)}/v1`;
  const token = cfg.server.gatewayToken?.trim() || "gbg-local";
  const snippet = buildGrokBootstrapSnippet(cfg);

  const backupDir =
    options.backupDir ?? getBackupDir();
  mkdirSync(backupDir, { recursive: true });

  let original = "";
  let backupPath: string | null = null;
  if (existsSync(path)) {
    original = readFileSync(path, "utf8");
    const ts = new Date()
      .toISOString()
      .replaceAll(":", "")
      .replaceAll(".", "")
      .replace("T", "_")
      .slice(0, 15);
    backupPath = join(backupDir, `config.toml.${ts}`);
    copyFileSync(path, backupPath);
  }

  // BOM-safe
  const text = original.replace(/^\uFEFF/, "");
  const lines = text.length ? text.split(/\r?\n/) : [];

  // [endpoints]
  const endpoints = ensureSection(lines, "[endpoints]");
  upsertKeyInSection(
    lines,
    endpoints,
    "models_base_url",
    `"${baseUrl}"`,
  );

  // [models] default — prefer first virtual model or grok-4.5
  const defaultModel =
    cfg.virtualModels[0]?.id ||
    cfg.modelMaps[0]?.from ||
    "grok-4.5";
  const modelsSec = ensureSection(lines, "[models]");
  upsertKeyInSection(lines, modelsSec, "default", `"${defaultModel}"`);

  // Upsert each virtual model + ensure grok-build alias if mapped
  const modelIds = new Map<string, VirtualModel | undefined>();
  for (const vm of cfg.virtualModels) {
    modelIds.set(vm.id, vm);
  }
  // Always keep common aliases if present in maps
  for (const m of cfg.modelMaps) {
    if (!modelIds.has(m.from)) {
      modelIds.set(m.from, {
        id: m.from,
        name: m.from,
        ownedBy: "gbg",
      });
    }
  }
  if (!modelIds.has("grok-build") && modelIds.has("grok-4.5")) {
    modelIds.set("grok-build", {
      id: "grok-build",
      name: "Grok Build alias",
      contextWindow: modelIds.get("grok-4.5")?.contextWindow,
      ownedBy: "gbg",
    });
  }

  for (const [id, vm] of modelIds) {
    const header = sectionHeaderForModel(id);
    const range = findSectionRange(lines, header);
    if (range) {
      upsertKeyInSection(lines, range, "model", `"${id}"`);
      upsertKeyInSection(lines, range, "base_url", `"${baseUrl}"`);
      upsertKeyInSection(lines, range, "api_backend", `"chat_completions"`);
      upsertKeyInSection(lines, range, "api_key", `"${token}"`);
      if (vm?.contextWindow) {
        upsertKeyInSection(
          lines,
          range,
          "context_window",
          String(vm.contextWindow),
        );
      }
      if (vm?.name) {
        upsertKeyInSection(
          lines,
          range,
          "name",
          `"${vm.name.replaceAll('"', '\\"')} (via GBG)"`,
        );
      }
    } else {
      if (lines.length && lines[lines.length - 1].trim() !== "") lines.push("");
      lines.push(...modelBlock(id, baseUrl, token, vm));
    }
  }

  const next = lines.join("\n").replace(/\n+$/, "\n");
  const changed = next !== (original.replace(/^\uFEFF/, "") || "");

  // ensure parent dir exists
  const dir = path.replace(/[\\/][^\\/]+$/, "");
  if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true });

  writeFileSync(path, next, "utf8");

  return {
    ok: true,
    path,
    backupPath,
    changed,
    message: changed
      ? `Updated ${path}${backupPath ? ` (backup: ${backupPath})` : ""}`
      : `No changes needed in ${path}`,
    snippet,
  };
}

export function previewGrokApply(cfg: GbgConfig): string {
  return buildGrokBootstrapSnippet(cfg);
}
