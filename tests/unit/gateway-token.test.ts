import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { signBridgeToken } from "@/domains/agents/bridge-token";
import {
  GATEWAY_AUDIENCE,
  GATEWAY_TOKEN_TTL_SECONDS,
  gatewaySecret,
  signGatewayToken,
  verifyGatewayToken,
} from "@/domains/agents/gateway-token";

const secret = "g".repeat(40);
const bridgeSecret = "b".repeat(40);
// Real UUIDs, not placeholders: the verifier rejects non-UUID run and workspace
// claims so a malformed token cannot reach Postgres as a 22P02 server error.
const claims = {
  runId: "3f2a1c4e-9b7d-4a51-8e2f-6c1d0b9a8f47",
  userId: "u1",
  workspaceId: "b81e5d20-4c93-4f7a-9d16-2a8c7e5b3f09",
};
const now = new Date("2026-10-18T12:00:00Z");

const encode = (value: string) => Buffer.from(value).toString("base64url");

/** A correctly signed token carrying an arbitrary payload, so one bad claim can be isolated. */
function mint(payload: Record<string, unknown>, signingSecret = secret): string {
  const body = `v1.${encode(JSON.stringify(payload))}`;
  const sig = createHmac("sha256", signingSecret).update(body).digest().toString("base64url");
  return `${body}.${sig}`;
}

const iat = Math.floor(now.getTime() / 1000);
const validPayload = {
  rid: claims.runId,
  uid: claims.userId,
  wid: claims.workspaceId,
  aud: GATEWAY_AUDIENCE,
  iat,
  exp: iat + GATEWAY_TOKEN_TTL_SECONDS,
  jti: "j1",
};

describe("gateway token", () => {
  it("round-trips the run, user, and workspace claims", () => {
    expect(verifyGatewayToken(signGatewayToken(claims, { secret, now }), { secret, now })).toEqual(claims);
  });

  it("rejects a forged signature and a tampered payload", () => {
    const token = signGatewayToken(claims, { secret, now });
    expect(verifyGatewayToken(token, { secret: "x".repeat(40), now })).toBeNull();

    const [, , sig] = token.split(".");
    const forged = encode(JSON.stringify({ ...validPayload, rid: "another-run" }));
    expect(verifyGatewayToken(`v1.${forged}.${sig}`, { secret, now })).toBeNull();
  });

  it("rejects a token minted for a different audience", () => {
    expect(verifyGatewayToken(mint({ ...validPayload, aud: "axiom-eve" }), { secret, now })).toBeNull();
  });

  it("rejects an expired token", () => {
    const token = signGatewayToken(claims, { secret, now });
    expect(verifyGatewayToken(token, { secret, now: new Date(now.getTime() + 30_000) })).toEqual(claims);
    expect(verifyGatewayToken(token, { secret, now: new Date(now.getTime() + 70_000) })).toBeNull();
  });

  it("rejects a lifetime longer than 60 seconds even when correctly signed", () => {
    expect(verifyGatewayToken(mint({ ...validPayload, exp: iat + 3600 }), { secret, now })).toBeNull();
  });

  it("rejects a token minted with the bridge secret", () => {
    // The two secrets are separate: compromising the bridge must not open the gateway.
    const bridge = signBridgeToken(
      { userId: claims.userId, workspaceId: claims.workspaceId, role: "owner" },
      { secret: bridgeSecret, now },
    );
    expect(verifyGatewayToken(bridge, { secret, now })).toBeNull();
    expect(verifyGatewayToken(bridge, { secret: bridgeSecret, now })).toBeNull();
    expect(verifyGatewayToken(mint(validPayload, bridgeSecret), { secret, now })).toBeNull();
  });

  it("refuses a short secret in both directions", () => {
    expect(() => signGatewayToken(claims, { secret: "short", now })).toThrow();
    expect(verifyGatewayToken(signGatewayToken(claims, { secret, now }), { secret: "short", now })).toBeNull();
    expect(gatewaySecret({ EVE_GATEWAY_SECRET: "short" } as unknown as NodeJS.ProcessEnv)).toBeNull();
    expect(gatewaySecret({} as NodeJS.ProcessEnv)).toBeNull();
    expect(gatewaySecret({ EVE_GATEWAY_SECRET: secret } as unknown as NodeJS.ProcessEnv)).toBe(secret);
  });

  it("rejects malformed tokens and a missing run claim", () => {
    expect(verifyGatewayToken("garbage", { secret, now })).toBeNull();
    expect(verifyGatewayToken("v1.a.b", { secret, now })).toBeNull();
    const withoutRun: Record<string, unknown> = { ...validPayload };
    delete withoutRun.rid;
    expect(verifyGatewayToken(mint(withoutRun), { secret, now })).toBeNull();
  });

  it("ignores a longer requested ttl instead of extending the window", () => {
    const token = signGatewayToken(claims, { secret, now, ttlSeconds: 3600 });
    expect(verifyGatewayToken(token, { secret, now: new Date(now.getTime() + 70_000) })).toBeNull();
  });

  it("rejects a well-signed token whose run or workspace is not a uuid", () => {
    // A signed-but-malformed claim is an auth failure. Passing it through would
    // reach Postgres and surface as a 500 from a UUID cast, not a 401.
    for (const [field, value] of [["rid", "run-1"], ["wid", "w1"]] as const) {
      expect(verifyGatewayToken(mint({ ...validPayload, [field]: value }), { secret, now })).toBeNull();
    }
  });
});
