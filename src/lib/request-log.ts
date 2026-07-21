import type { RequestLogEntry } from "../server/types.js";

const MAX_ENTRIES = 100;

/**
 * Fixed-capacity ring buffer — O(1) add, no array shifts.
 * Keeps running totals so stats() is O(1).
 */
export class RequestLog {
  private readonly buf: Array<RequestLogEntry | undefined>;
  private head = 0; // next write index
  private size = 0;
  private lifetimeTotal = 0;
  private lifetimeErrors = 0;
  private lifetimeLatencySum = 0;
  private windowLatencySum = 0;
  private byProvider: Record<string, number> = {};
  private rev = 0;

  constructor(capacity = MAX_ENTRIES) {
    this.buf = new Array(capacity);
  }

  get revision(): number {
    return this.rev;
  }

  add(entry: RequestLogEntry): void {
    const cap = this.buf.length;
    if (this.size === cap) {
      const old = this.buf[this.head];
      if (old) this.untrack(old);
    } else {
      this.size += 1;
    }
    this.buf[this.head] = entry;
    this.head = (this.head + 1) % cap;
    this.track(entry);
    this.lifetimeTotal += 1;
    this.lifetimeLatencySum += entry.latencyMs;
    if (entry.status >= 400 || entry.error) this.lifetimeErrors += 1;
    this.rev += 1;
  }

  private track(e: RequestLogEntry): void {
    this.windowLatencySum += e.latencyMs;
    const pid = e.providerId ?? "unknown";
    this.byProvider[pid] = (this.byProvider[pid] ?? 0) + 1;
  }

  private untrack(e: RequestLogEntry): void {
    this.windowLatencySum -= e.latencyMs;
    const pid = e.providerId ?? "unknown";
    const n = (this.byProvider[pid] ?? 1) - 1;
    if (n <= 0) delete this.byProvider[pid];
    else this.byProvider[pid] = n;
  }

  list(limit = 50): RequestLogEntry[] {
    const n = Math.max(0, Math.min(limit, this.size));
    if (n === 0) return [];
    const cap = this.buf.length;
    const out: RequestLogEntry[] = new Array(n);
    // newest first
    for (let i = 0; i < n; i++) {
      const idx = (this.head - 1 - i + cap * 2) % cap;
      out[i] = this.buf[idx]!;
    }
    return out;
  }

  stats(): {
    total: number;
    errors: number;
    avgLatencyMs: number;
    byProvider: Record<string, number>;
    lifetimeTotal: number;
    lifetimeErrors: number;
    windowSize: number;
  } {
    const windowSize = this.size;
    return {
      total: this.lifetimeTotal,
      errors: this.lifetimeErrors,
      avgLatencyMs:
        windowSize === 0
          ? 0
          : Math.round(this.windowLatencySum / windowSize),
      byProvider: { ...this.byProvider },
      lifetimeTotal: this.lifetimeTotal,
      lifetimeErrors: this.lifetimeErrors,
      windowSize,
    };
  }

  clear(): void {
    this.buf.fill(undefined);
    this.head = 0;
    this.size = 0;
    this.windowLatencySum = 0;
    this.byProvider = {};
    this.rev += 1;
  }
}

export const globalRequestLog = new RequestLog();
