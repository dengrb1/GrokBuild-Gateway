import { afterEach, describe, expect, it } from "vitest";
import { isEnvRef, maskSecret, resolveSecret } from "../src/lib/secrets.js";

describe("secrets", () => {
  const prev = process.env.GBG_TEST_KEY;

  afterEach(() => {
    if (prev === undefined) delete process.env.GBG_TEST_KEY;
    else process.env.GBG_TEST_KEY = prev;
  });

  it("resolves env refs", () => {
    process.env.GBG_TEST_KEY = "secret-value";
    expect(resolveSecret("env:GBG_TEST_KEY")).toBe("secret-value");
    expect(resolveSecret("plain-key")).toBe("plain-key");
    expect(resolveSecret("env:MISSING_VAR_XYZ")).toBe("");
  });

  it("masks secrets but keeps env refs", () => {
    expect(maskSecret("env:OKINTO_API_KEY")).toBe("env:OKINTO_API_KEY");
    expect(maskSecret("sk-abcdefghijklmnop")).toMatch(/^sk-a…/);
    expect(isEnvRef("env:X")).toBe(true);
  });
});
