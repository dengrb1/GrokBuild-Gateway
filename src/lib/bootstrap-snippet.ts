import type { GbgConfig } from "../server/types.js";
import { gatewayBaseUrl } from "./proxy-shield.js";

function escapeTomlKey(id: string): string {
  if (/^[A-Za-z0-9_-]+$/.test(id) && !id.includes(".")) return id;
  return `"${id.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

export function buildGrokBootstrapSnippet(cfg: GbgConfig): string {
  // Always 127.0.0.1 — never localhost — so system proxies / ::1 cannot break Grok
  const base = `${gatewayBaseUrl(cfg.server.host, cfg.server.port)}/v1`;
  const token = cfg.server.gatewayToken?.trim() || "gbg-local";
  const defaultModel =
    cfg.virtualModels[0]?.id ||
    cfg.modelMaps[0]?.from ||
    "grok-4.5";

  const modelIds = new Map<
    string,
    { name?: string; contextWindow?: number }
  >();
  for (const vm of cfg.virtualModels) {
    modelIds.set(vm.id, {
      name: vm.name,
      contextWindow: vm.contextWindow,
    });
  }
  for (const m of cfg.modelMaps) {
    if (!modelIds.has(m.from)) {
      modelIds.set(m.from, { name: m.from });
    }
  }
  if (!modelIds.size) {
    modelIds.set("grok-4.5", { name: "Grok 4.5", contextWindow: 500000 });
    modelIds.set("grok-build", {
      name: "Grok Build alias",
      contextWindow: 500000,
    });
  }

  const blocks: string[] = [
    `[endpoints]`,
    `models_base_url = "${base}"`,
    ``,
    `[models]`,
    `default = "${defaultModel}"`,
  ];

  for (const [id, meta] of modelIds) {
    const name = (meta.name || id).replaceAll('"', '\\"');
    const ctx = meta.contextWindow ?? 200000;
    blocks.push(
      ``,
      `[model.${escapeTomlKey(id)}]`,
      `model = "${id}"`,
      `base_url = "${base}"`,
      `api_backend = "chat_completions"`,
      `name = "${name} (via GBG)"`,
      `api_key = "${token}"`,
      `context_window = ${ctx}`,
      `max_completion_tokens = 65536`,
    );
  }

  return `${blocks.join("\n")}\n`;
}
