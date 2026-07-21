/**
 * Optional: merge loopback entries into the *user* NO_PROXY environment variable.
 * Does NOT modify Windows WinINET system proxy settings.
 */
import { execFileSync } from "node:child_process";
import { LOOPBACK_NO_PROXY, mergeNoProxy } from "./proxy-shield.js";

export interface FixUserNoProxyResult {
  ok: boolean;
  previous: string | null;
  next: string;
  message: string;
}

function readUserEnvWindows(name: string): string | null {
  try {
    const out = execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-Command",
        `[Environment]::GetEnvironmentVariable('${name}','User')`,
      ],
      { encoding: "utf8", windowsHide: true, timeout: 8000 },
    ).trim();
    return out || null;
  } catch {
    return process.env[name] ?? null;
  }
}

function writeUserEnvWindows(name: string, value: string): void {
  // Pass value via env var to avoid injection / quoting issues
  execFileSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-Command",
      `[Environment]::SetEnvironmentVariable('${name}', $env:GBG_NOPROXY_VALUE, 'User')`,
    ],
    {
      encoding: "utf8",
      windowsHide: true,
      timeout: 8000,
      env: { ...process.env, GBG_NOPROXY_VALUE: value },
    },
  );
}

export function fixUserNoProxy(): FixUserNoProxyResult {
  const isWin = process.platform === "win32";
  let previous: string | null = null;

  if (isWin) {
    previous = readUserEnvWindows("NO_PROXY") ?? readUserEnvWindows("no_proxy");
  } else {
    previous = process.env.NO_PROXY ?? process.env.no_proxy ?? null;
  }

  const next = mergeNoProxy(previous, LOOPBACK_NO_PROXY);

  if (isWin) {
    writeUserEnvWindows("NO_PROXY", next);
    process.env.NO_PROXY = next;
    process.env.no_proxy = next;
    return {
      ok: true,
      previous,
      next,
      message: `User NO_PROXY updated (open a new terminal for other apps): ${next}`,
    };
  }

  process.env.NO_PROXY = next;
  process.env.no_proxy = next;
  return {
    ok: true,
    previous,
    next,
    message:
      `Process NO_PROXY set to: ${next}. ` +
      `Export permanently in your shell profile: export NO_PROXY="${next}"`,
  };
}
