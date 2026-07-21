import { describe, expect, it } from "vitest";
import { RequestLog } from "../src/lib/request-log.js";

describe("RequestLog ring buffer", () => {
  it("keeps fixed capacity and newest-first list", () => {
    const log = new RequestLog(3);
    for (let i = 1; i <= 5; i++) {
      log.add({
        id: String(i),
        ts: i,
        method: "POST",
        path: "/v1/chat/completions",
        modelIn: "a",
        modelOut: "b",
        providerId: "p",
        status: 200,
        latencyMs: 10 * i,
      });
    }
    const list = log.list(10);
    expect(list).toHaveLength(3);
    expect(list.map((e) => e.id)).toEqual(["5", "4", "3"]);
    const stats = log.stats();
    expect(stats.lifetimeTotal).toBe(5);
    expect(stats.windowSize).toBe(3);
    expect(stats.avgLatencyMs).toBe(Math.round((50 + 40 + 30) / 3));
  });
});
