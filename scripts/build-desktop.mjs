/**
 * Build self-contained gbg-desktop.exe with the gateway binary embedded.
 *
 * Output: release/gbg-desktop.exe  (single file — no sidecar gbg.exe required)
 *
 * Prerequisites:
 * - Rust / cargo
 * - Bun (for gbg.exe) unless release/gbg.exe already exists
 * - Windows WebView2 (usually preinstalled)
 */
import { execFileSync, spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  statSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const releaseDir = join(root, "release");
const gbgExe = join(releaseDir, "gbg.exe");
const desktopSrc = join(root, "src-tauri", "target", "release", "gbg-desktop.exe");
const desktopOut = join(releaseDir, "gbg-desktop.exe");

function run(cmd, args, opts = {}) {
  console.log(`> ${cmd} ${args.join(" ")}`);
  const r = spawnSync(cmd, args, {
    cwd: opts.cwd ?? root,
    stdio: "inherit",
    shell: process.platform === "win32",
    env: process.env,
  });
  if (r.status !== 0) {
    process.exit(r.status ?? 1);
  }
}

mkdirSync(releaseDir, { recursive: true });

// Gateway must exist before cargo include_bytes!
console.log("Building embedded gateway (gbg.exe)…");
run("npm", ["run", "build:exe"]);

if (!existsSync(gbgExe)) {
  console.error("Failed to produce release/gbg.exe");
  process.exit(1);
}

try {
  execFileSync("cargo", ["--version"], { stdio: "pipe" });
} catch {
  console.error("cargo not found. Install Rust from https://rustup.rs");
  process.exit(1);
}

console.log("Compiling desktop with embedded gateway…");
run("cargo", ["build", "--release"], { cwd: join(root, "src-tauri") });

if (!existsSync(desktopSrc)) {
  console.error(`Desktop binary not found: ${desktopSrc}`);
  process.exit(1);
}

copyFileSync(desktopSrc, desktopOut);

const sz = (p) => `${(statSync(p).size / 1024 / 1024).toFixed(2)} MB`;
console.log("");
console.log("Desktop build OK (gateway built-in):");
console.log(`  ${desktopOut}  (${sz(desktopOut)})`);
console.log(`  (also available) ${gbgExe}  (${sz(gbgExe)})  — optional CLI-only use`);
console.log("");
console.log("Run single file:");
console.log("  .\\release\\gbg-desktop.exe");
console.log("Gateway extracts to %LOCALAPPDATA%\\GrokBuild-Gateway\\runtime\\gbg.exe on first start.");
