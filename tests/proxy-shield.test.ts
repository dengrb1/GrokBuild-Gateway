import { afterEach, describe, expect, it } from "vitest";
import {
  applyProxyShield,
  diagnoseProxyEnv,
  gatewayBaseUrl,
  gatewayLoopbackHost,
  mergeNoProxy,
  noProxyCoversLoopback,
  parseNoProxyList,
  restoreProxyEnv,
} from "../src/lib/proxy-shield.js";
import {
  isGlobalProxyShieldOn,
  isProviderProxyShieldOn,
  proxyModeFromShield,
} from "../src/server/types.js";

afterEach(() => {
  restoreProxyEnv();
  delete process.env.HTTP_PROXY;
  delete process.env.HTTPS_PROXY;
  delete process.env.http_proxy;
  delete process.env.https_proxy;
  delete process.env.ALL_PROXY;
  delete process.env.NO_PROXY;
  delete process.env.no_proxy;
});

describe("mergeNoProxy", () => {
  it("merges loopback defaults", () => {
    const s = mergeNoProxy(undefined);
    expect(s).toContain("127.0.0.1");
    expect(s).toContain("localhost");
    expect(s).toContain("::1");
  });

  it("dedupes case-insensitively", () => {
    const s = mergeNoProxy("LOCALHOST,example.com", ["127.0.0.1", "localhost"]);
    const parts = parseNoProxyList(s);
    expect(parts.filter((p) => p.toLowerCase() === "localhost")).toHaveLength(1);
    expect(parts).toContain("example.com");
  });

  it("preserves existing entries", () => {
    const s = mergeNoProxy("*.local,10.0.0.0/8");
    expect(s).toContain("*.local");
    expect(s).toContain("10.0.0.0/8");
    expect(s).toContain("127.0.0.1");
  });
});

describe("noProxyCoversLoopback", () => {
  it("detects 127.0.0.1", () => {
    expect(noProxyCoversLoopback("127.0.0.1,foo")).toBe(true);
  });
  it("detects <local> and *", () => {
    expect(noProxyCoversLoopback("<local>")).toBe(true);
    expect(noProxyCoversLoopback("*")).toBe(true);
  });
  it("false when empty", () => {
    expect(noProxyCoversLoopback("")).toBe(false);
    expect(noProxyCoversLoopback("example.com")).toBe(false);
  });
});

describe("gatewayLoopbackHost", () => {
  it("normalizes bind-all and localhost to 127.0.0.1", () => {
    expect(gatewayLoopbackHost("0.0.0.0")).toBe("127.0.0.1");
    expect(gatewayLoopbackHost("localhost")).toBe("127.0.0.1");
    expect(gatewayLoopbackHost("::")).toBe("127.0.0.1");
    expect(gatewayLoopbackHost("127.0.0.1")).toBe("127.0.0.1");
  });
  it("keeps custom host", () => {
    expect(gatewayLoopbackHost("192.168.1.5")).toBe("192.168.1.5");
  });
  it("builds base url", () => {
    expect(gatewayBaseUrl("0.0.0.0", 8787)).toBe("http://127.0.0.1:8787");
  });
});

describe("applyProxyShield", () => {
  it("sets NO_PROXY and strips proxy env in direct mode", () => {
    process.env.HTTP_PROXY = "http://127.0.0.1:9";
    process.env.HTTPS_PROXY = "http://127.0.0.1:9";
    const st = applyProxyShield("direct");
    expect(st.mode).toBe("direct");
    expect(st.noProxy).toContain("127.0.0.1");
    expect(process.env.NO_PROXY).toContain("127.0.0.1");
    expect(process.env.HTTP_PROXY).toBeUndefined();
    expect(process.env.HTTPS_PROXY).toBeUndefined();
    expect(st.strippedProxyKeys.length).toBeGreaterThan(0);
    expect(st.hadProxyEnv).toBe(true);
  });

  it("keeps proxy env in env mode but still sets NO_PROXY", () => {
    process.env.HTTP_PROXY = "http://proxy.example:8080";
    const st = applyProxyShield("env");
    expect(st.mode).toBe("env");
    expect(process.env.HTTP_PROXY).toBe("http://proxy.example:8080");
    expect(process.env.NO_PROXY).toContain("127.0.0.1");
  });
});

describe("diagnoseProxyEnv", () => {
  it("warns when proxy set without loopback bypass and no shield", () => {
    restoreProxyEnv();
    process.env.HTTP_PROXY = "http://proxy:1";
    delete process.env.NO_PROXY;
    delete process.env.no_proxy;
    // diagnose without applied shield state
    const findings = diagnoseProxyEnv(process.env, null);
    expect(findings.some((f) => f.code === "proxy_without_loopback_bypass")).toBe(
      true,
    );
  });

  it("ok when shield applied", () => {
    process.env.HTTP_PROXY = "http://proxy:1";
    const st = applyProxyShield("direct");
    const findings = diagnoseProxyEnv(process.env, st);
    expect(findings.some((f) => f.code === "shield_applied")).toBe(true);
  });
});

describe("global + provider proxy shield policy", () => {
  it("maps boolean to proxyMode", () => {
    expect(proxyModeFromShield(true)).toBe("direct");
    expect(proxyModeFromShield(false)).toBe("env");
  });

  it("global on by default / proxyMode", () => {
    expect(isGlobalProxyShieldOn({ proxyShield: true, proxyMode: "direct" })).toBe(
      true,
    );
    expect(isGlobalProxyShieldOn({ proxyShield: false, proxyMode: "env" })).toBe(
      false,
    );
    expect(isGlobalProxyShieldOn({ proxyMode: "env" } as never)).toBe(false);
  });

  it("provider effective requires both on", () => {
    const serverOn = { proxyShield: true, proxyMode: "direct" as const };
    const serverOff = { proxyShield: false, proxyMode: "env" as const };
    expect(isProviderProxyShieldOn(serverOn, { proxyShield: true })).toBe(true);
    expect(isProviderProxyShieldOn(serverOn, { proxyShield: false })).toBe(false);
    expect(isProviderProxyShieldOn(serverOff, { proxyShield: true })).toBe(false);
    expect(isProviderProxyShieldOn(serverOn, {})).toBe(true);
  });

  it("can switch process shield mode direct ↔ env", () => {
    process.env.HTTP_PROXY = "http://proxy.example:8080";
    applyProxyShield("direct");
    expect(process.env.HTTP_PROXY).toBeUndefined();
    applyProxyShield("env");
    expect(process.env.HTTP_PROXY).toBe("http://proxy.example:8080");
    applyProxyShield("direct");
    expect(process.env.HTTP_PROXY).toBeUndefined();
  });
});
