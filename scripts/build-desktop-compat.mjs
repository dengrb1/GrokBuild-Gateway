/**
 * Build WebView2-free / Win7-friendly tray client:
 *   release/gbg-desktop-compat.exe
 *
 * - No Edge WebView2 runtime
 * - WebUI opens in the system default browser
 * - Same embedded gbg.exe lifecycle as the Tauri desktop build
 * - Static CRT + PE subsystem 6.01 (Windows 7)
 *
 * Prerequisites: Rust/cargo, and release/gbg.exe (built automatically).
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
const crateDir = join(root, "src-desktop-compat");
const desktopSrc = join(
  crateDir,
  "target",
  "release",
  "gbg-desktop-compat.exe",
);
const desktopOut = join(releaseDir, "gbg-desktop-compat.exe");

function run(cmd, args, opts = {}) {
  const isWindowsNpm = process.platform === "win32" && cmd === "npm";
  const executable = isWindowsNpm ? process.env.ComSpec ?? "cmd.exe" : cmd;
  const commandArgs = isWindowsNpm
    ? ["/d", "/s", "/c", `npm.cmd ${args.map(quoteCmdArg).join(" ")}`]
    : args;
  console.log(`> ${isWindowsNpm ? "npm.cmd" : cmd} ${args.join(" ")}`);
  const r = spawnSync(executable, commandArgs, {
    cwd: opts.cwd ?? root,
    stdio: "inherit",
    env: process.env,
  });
  if (r.error) {
    console.error(`Failed to start ${cmd}: ${r.error.message}`);
    process.exit(1);
  }
  if (r.status !== 0) {
    process.exit(r.status ?? 1);
  }
}

function quoteCmdArg(arg) {
  return /[\s"]/u.test(arg) ? `"${arg.replaceAll('"', '\\"')}"` : arg;
}

if (process.platform !== "win32") {
  console.error("gbg-desktop-compat is Windows-only.");
  process.exit(1);
}

mkdirSync(releaseDir, { recursive: true });

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

// Keep tray icon in sync with the Tauri shell
const iconSrc = join(root, "src-tauri", "icons", "icon.ico");
const iconDst = join(crateDir, "icon.ico");
if (existsSync(iconSrc)) {
  copyFileSync(iconSrc, iconDst);
}

console.log("Compiling WebView2-free desktop compat shell…");
// Link the final GUI executable for the Windows 7 subsystem. This must not
// live in .cargo/config.toml: Cargo applies target rustflags to build scripts,
// which are console programs and therefore require a WinMain entry point.
run(
  "cargo",
  [
    "rustc",
    "--release",
    "--",
    "-C",
    "link-arg=/SUBSYSTEM:WINDOWS,6.01",
  ],
  { cwd: crateDir },
);

if (!existsSync(desktopSrc)) {
  console.error(`Compat desktop binary not found: ${desktopSrc}`);
  process.exit(1);
}

copyFileSync(desktopSrc, desktopOut);

const sz = (p) => `${(statSync(p).size / 1024 / 1024).toFixed(2)} MB`;
console.log("");
console.log("Desktop COMPAT build OK (no WebView2, Win7-oriented):");
console.log(`  ${desktopOut}  (${sz(desktopOut)})`);
console.log(`  (gateway) ${gbgExe}  (${sz(gbgExe)})`);
console.log("");
console.log("Run:");
console.log("  .\\release\\gbg-desktop-compat.exe");
console.log("");
console.log("Notes:");
console.log("  - Does NOT require WebView2 / Edge runtime");
console.log("  - Opens WebUI in the system default browser");
console.log("  - Tray: left-click open UI · right-click start/stop/autostart");
console.log("  - Args: --no-gateway  --autostart  --minimized  --no-open");
console.log("  - Env:  GBG_PORT  GBG_EXE  GBG_USE_EXTERNAL=1");
