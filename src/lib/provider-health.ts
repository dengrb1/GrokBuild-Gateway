export interface ProviderHealthSnapshot {
  providerId: string;
  consecutiveFailures: number;
  cooldownUntil: number;
  coolingDown: boolean;
  lastError?: string;
  lastSuccessAt?: number;
  lastFailureAt?: number;
}

interface ProviderHealthState {
  consecutiveFailures: number;
  cooldownUntil: number;
  lastError?: string;
  lastSuccessAt?: number;
  lastFailureAt?: number;
}

const health = new Map<string, ProviderHealthState>();

function getState(providerId: string): ProviderHealthState {
  let state = health.get(providerId);
  if (!state) {
    state = { consecutiveFailures: 0, cooldownUntil: 0 };
    health.set(providerId, state);
  }
  return state;
}

export function isProviderCoolingDown(
  providerId: string,
  now = Date.now(),
): boolean {
  const state = health.get(providerId);
  if (!state) return false;
  return state.cooldownUntil > now;
}

export function markProviderSuccess(providerId: string, now = Date.now()): void {
  const state = getState(providerId);
  state.consecutiveFailures = 0;
  state.cooldownUntil = 0;
  state.lastSuccessAt = now;
  state.lastError = undefined;
}

export function markProviderFailure(
  providerId: string,
  error: string,
  options: { consecutiveFailures: number; cooldownMs: number },
  now = Date.now(),
): ProviderHealthState {
  const state = getState(providerId);
  state.consecutiveFailures += 1;
  state.lastFailureAt = now;
  state.lastError = error;
  if (state.consecutiveFailures >= options.consecutiveFailures) {
    state.cooldownUntil = now + Math.max(0, options.cooldownMs);
  }
  return state;
}

export function listProviderHealth(now = Date.now()): ProviderHealthSnapshot[] {
  const out: ProviderHealthSnapshot[] = [];
  for (const [providerId, state] of health) {
    out.push({
      providerId,
      consecutiveFailures: state.consecutiveFailures,
      cooldownUntil: state.cooldownUntil,
      coolingDown: state.cooldownUntil > now,
      lastError: state.lastError,
      lastSuccessAt: state.lastSuccessAt,
      lastFailureAt: state.lastFailureAt,
    });
  }
  return out.sort((a, b) => a.providerId.localeCompare(b.providerId));
}

export function resetProviderHealth(): void {
  health.clear();
}

export function isFailoverableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

export function isFailoverableError(err: unknown, timedOut: boolean): boolean {
  if (timedOut) return true;
  if (!(err instanceof Error)) return true;
  if (err.name === "AbortError") return true;
  return true;
}
