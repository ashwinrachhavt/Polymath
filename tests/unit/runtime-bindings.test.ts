import { afterEach, describe, expect, it, vi } from "vitest";
import { canonicalHash, canonicalize, executionEnvironment } from "@/domains/agents/runtime-bindings";

/*
 * The hash is the dedupe rule for signals and tool invocations, so its
 * canonicalization is the contract: key order, whitespace, and undefined must
 * never change the identity of the same logical request.
 */
describe("canonicalize / canonicalHash", () => {
  it("is stable across object key order", () => {
    expect(canonicalize({ b: 1, a: { d: 2, c: 3 } })).toBe(canonicalize({ a: { c: 3, d: 2 }, b: 1 }));
    expect(canonicalHash({ to: "x", subject: "y" })).toBe(canonicalHash({ subject: "y", to: "x" }));
  });

  it("drops undefined but keeps null and array order", () => {
    expect(canonicalize({ a: undefined, b: null })).toBe(canonicalize({ b: null }));
    expect(canonicalize([2, 1])).not.toBe(canonicalize([1, 2]));
  });

  it("distinguishes different payloads", () => {
    expect(canonicalHash({ a: 1 })).not.toBe(canonicalHash({ a: 2 }));
    expect(canonicalHash({ a: 1 })).not.toBe(canonicalHash({ a: "1" }));
  });
});

describe("executionEnvironment", () => {
  afterEach(() => vi.unstubAllEnvs());
  it("prefers the Vercel environment label", () => {
    vi.stubEnv("VERCEL_ENV", "preview");
    expect(executionEnvironment()).toBe("preview");
  });
});
