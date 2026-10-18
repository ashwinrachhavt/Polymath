import { describe, expect, it } from "vitest";
import { bridgeSecret, signBridgeToken, verifyBridgeToken } from "@/domains/agents/bridge-token";

const secret = "s".repeat(40);
const claims = { userId: "u1", workspaceId: "w1", role: "member" as const };
const now = new Date("2026-10-18T12:00:00Z");

describe("bridge token", () => {
  it("round-trips claims", () => {
    expect(verifyBridgeToken(signBridgeToken(claims, { secret, now }), { secret, now })).toEqual(claims);
  });
  it("rejects a wrong secret and a tampered payload", () => {
    const token = signBridgeToken(claims, { secret, now });
    expect(verifyBridgeToken(token, { secret: "x".repeat(40), now })).toBeNull();
    const [v, , sig] = token.split(".");
    const forged = Buffer.from(JSON.stringify({ uid: "u1", wid: "other", role: "owner", aud: "axiom-eve", iat: 1, exp: 99999999999, jti: "j" })).toString("base64url");
    expect(verifyBridgeToken(`${v}.${forged}.${sig}`, { secret, now })).toBeNull();
  });
  it("expires after 60 seconds and ignores a longer requested ttl", () => {
    const token = signBridgeToken(claims, { secret, now, ttlSeconds: 3600 });
    expect(verifyBridgeToken(token, { secret, now: new Date(now.getTime() + 30_000) })).toEqual(claims);
    expect(verifyBridgeToken(token, { secret, now: new Date(now.getTime() + 70_000) })).toBeNull();
  });
  it("rejects malformed tokens and short secrets", () => {
    expect(verifyBridgeToken("garbage", { secret, now })).toBeNull();
    expect(verifyBridgeToken("v1.a.b", { secret, now })).toBeNull();
    expect(() => signBridgeToken(claims, { secret: "short" })).toThrow();
    expect(bridgeSecret({ EVE_BRIDGE_SECRET: "short" } as unknown as NodeJS.ProcessEnv)).toBeNull();
    expect(bridgeSecret({ EVE_BRIDGE_SECRET: secret } as unknown as NodeJS.ProcessEnv)).toBe(secret);
  });
});
