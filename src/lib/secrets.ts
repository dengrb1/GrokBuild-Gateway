/** Resolve api keys. Supports plain strings or `env:VAR_NAME` references. */
export function resolveSecret(value: string | null | undefined): string {
  if (!value) return "";
  const trimmed = value.trim();
  if (trimmed.startsWith("env:")) {
    const varName = trimmed.slice(4).trim();
    if (!varName) return "";
    return process.env[varName]?.trim() ?? "";
  }
  return trimmed;
}

/** Mask secrets for logs / API responses. */
export function maskSecret(value: string | null | undefined): string {
  if (!value) return "";
  const trimmed = value.trim();
  if (trimmed.startsWith("env:")) return trimmed;
  if (trimmed.length <= 8) return "****";
  return `${trimmed.slice(0, 4)}…${trimmed.slice(-4)}`;
}

export function isEnvRef(value: string | null | undefined): boolean {
  return Boolean(value?.trim().startsWith("env:"));
}
