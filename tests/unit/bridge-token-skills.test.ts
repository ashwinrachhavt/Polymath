import { createHmac, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { signBridgeToken, verifyBridgeToken } from "@/domains/agents/bridge-token";

const secret = "s".repeat(40);
const claims = { userId: "u1", workspaceId: "w1", role: "member" as const };
const now = new Date("2026-10-18T12:00:00Z");

/** A correctly signed token around an arbitrary payload, for shapes signBridgeToken would never emit. */
function signPayload(payload: Record<string, unknown>): string {
  const body = `v1.${Buffer.from(JSON.stringify(payload)).toString("base64url")}`;
  const signature = createHmac("sha256", secret).update(body).digest().toString("base64url");
  return `${body}.${signature}`;
}

const iat = Math.floor(now.getTime() / 1000);
const basePayload = {
  uid: claims.userId,
  wid: claims.workspaceId,
  role: claims.role,
  aud: "axiom-eve",
  iat,
  exp: iat + 60,
  jti: randomUUID(),
};

describe("bridge token skill claims", () => {
  it("round-trips runId and skillId", () => {
    const token = signBridgeToken(
      { ...claims, runId: "run_1", skillId: "skill_1" },
      { secret, now },
    );
    expect(verifyBridgeToken(token, { secret, now })).toEqual({
      ...claims,
      runId: "run_1",
      skillId: "skill_1",
    });
  });

  it("omits the claims entirely when they are not supplied", () => {
    const token = signBridgeToken(claims, { secret, now });
    expect(verifyBridgeToken(token, { secret, now })).toEqual(claims);
    const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
    expect(payload).not.toHaveProperty("rid");
    expect(payload).not.toHaveProperty("skid");
  });

  it("rejects a tampered skid", () => {
    const token = signBridgeToken({ ...claims, skillId: "skill_1" }, { secret, now });
    const [v, payload, sig] = token.split(".");
    const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    const forged = Buffer.from(JSON.stringify({ ...decoded, skid: "skill_2" })).toString("base64url");
    expect(verifyBridgeToken(`${v}.${forged}.${sig}`, { secret, now })).toBeNull();
  });

  it("rejects a non-string skid in a correctly signed payload", () => {
    const token = signPayload({ ...basePayload, skid: 42 });
    expect(verifyBridgeToken(token, { secret, now })).toBeNull();
    const runToken = signPayload({ ...basePayload, rid: { id: "run_1" } });
    expect(verifyBridgeToken(runToken, { secret, now })).toBeNull();
  });
});
