import { describe, expect, it } from "vitest";
import { mintApiKeySecret, parseApiKey } from "@/domains/identity/machine";
import { ForbiddenRoleError, requireScope } from "@/lib/auth/guards";
import type { AuthContext } from "@/domains/identity/resolve";

/*
 * The API-key token contract, without a database: format, round-trip parse,
 * and the scope guard's human-vs-machine split.
 */

describe("API key token format", () => {
  it("mints axm_<keyId>.<secret> and parses it back", () => {
    const { keyId, secret, token } = mintApiKeySecret();
    expect(token).toBe(`axm_${keyId}.${secret}`);
    expect(parseApiKey(token)).toEqual({ keyId, secret });
  });

  it("never repeats itself", () => {
    expect(mintApiKeySecret().token).not.toBe(mintApiKeySecret().token);
  });

  it("rejects malformed tokens", () => {
    for (const bad of [
      "",
      "axm_",
      "axm_short.secret",
      "axm_abcdefghijkl", // legacy undivided secret: not the split format
      "bearer axm_abcdefghijkl.mnopqrstuvwx",
      `axm_${"a".repeat(12)}.${"b".repeat(42)}`, // secret one char short
    ]) {
      expect(parseApiKey(bad)).toBeNull();
    }
  });

  it("leaves legacy undivided secrets to the digest-lookup path", () => {
    // Legacy tokens were base64url with no fixed length and no dot; the
    // resolver must not mistake one for the split format.
    expect(parseApiKey(`axm_${"Ab1-_".repeat(9)}`)).toBeNull();
  });
});

describe("requireScope", () => {
  const human: AuthContext = { userId: "u", workspaceId: "w", role: "member" };
  const machine = (scopes: string[]): AuthContext => ({
    userId: "c",
    workspaceId: "w",
    role: "member",
    scopes,
  });

  it("is a no-op for humans; their role check is the whole guard", () => {
    expect(() => requireScope(human, "captures:write")).not.toThrow();
  });

  it("passes a machine client that carries the scope", () => {
    expect(() => requireScope(machine(["captures:read", "captures:write"]), "captures:write")).not.toThrow();
  });

  it("rejects a machine client missing the scope", () => {
    expect(() => requireScope(machine(["captures:read"]), "captures:write")).toThrow(ForbiddenRoleError);
    expect(() => requireScope(machine([]), "captures:read")).toThrow(ForbiddenRoleError);
  });
});
