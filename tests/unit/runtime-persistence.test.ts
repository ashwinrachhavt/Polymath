import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ db: {} }));

import { canonicalJson, hashCanonical, redactForStorage } from "@/domains/agents/runtime-persistence";

describe("canonical hashing", () => {
  it("ignores key order and undefined fields", async () => {
    const a = { to: "x", nested: { b: 1, a: [1, 2] }, skip: undefined };
    const b = { nested: { a: [1, 2], b: 1 }, to: "x" };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
    expect(await hashCanonical(a)).toBe(await hashCanonical(b));
  });

  it("changes when an argument changes, including array order", async () => {
    expect(await hashCanonical({ n: 1 })).not.toBe(await hashCanonical({ n: 2 }));
    expect(await hashCanonical([1, 2])).not.toBe(await hashCanonical([2, 1]));
  });
});

describe("redactForStorage", () => {
  it("strips secret-looking keys at any depth and keeps the rest", () => {
    expect(
      redactForStorage({ query: "rent", auth: { apiKey: "k", Authorization: "Bearer z" }, list: [{ password: "p", ok: 1 }] }),
    ).toEqual({ query: "rent", auth: { apiKey: "[redacted]", Authorization: "[redacted]" }, list: [{ password: "[redacted]", ok: 1 }] });
  });
});
