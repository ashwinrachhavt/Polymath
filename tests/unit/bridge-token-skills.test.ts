import { createHmac, randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

/*
 * The driver half: every token minted for a run must carry the same pin. A
 * follow-up is an active inbound turn, so a claim-less signal token would let
 * the skill resolver fall back to no skill mid-session.
 */
const mocks = vi.hoisted(() => ({ select: vi.fn(), update: vi.fn() }));
vi.mock("@/lib/db", () => ({ db: { select: mocks.select, update: mocks.update } }));
vi.mock("eve/channels/eve", () => ({ eveChannel: (config: unknown) => config }));
vi.mock("eve/channels/auth", () => ({ localDev: () => async () => null }));

const { createEveDriver } = await import("@/domains/agents/eve-driver");

const auth = { userId: claims.userId, workspaceId: claims.workspaceId, role: claims.role };
const policy = {
  profileId: "profile",
  model: "m",
  allowedTools: [],
  allowedAccounts: [],
  budgetUsd: {},
  auth,
  skill: { id: "skill_1", revision: "r1", contentHash: "h1", name: "Release" },
};

/** The run row the driver's signal read returns, shaped for drizzle's chain. */
function runRow(row: { sessionRef: string; policySnapshot: unknown }) {
  return { from: () => ({ where: () => ({ limit: async () => [row] }) }) };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("EVE_BASE_URL", "http://eve.fixture");
  vi.stubEnv("EVE_BRIDGE_SECRET", secret);
  mocks.update.mockReturnValue({ set: () => ({ where: async () => [] }) });
});
afterEach(() => vi.unstubAllEnvs());

describe("the driver's run pin", () => {
  it("start and signal mint the same runId and skillId for the same run", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(Response.json({ sessionId: "wrun_1" }, { status: 202 }))
      .mockResolvedValueOnce(Response.json({ ok: true }));
    vi.stubGlobal("fetch", fetch);
    mocks.select.mockReturnValue(runRow({ sessionRef: "wrun_1", policySnapshot: policy }));

    const driver = createEveDriver();
    await driver.start({ sessionId: "run_1", auth, policy, instructions: null, objective: "Go" });
    await driver.signal("run_1", "Keep going", auth);

    const tokenAt = (call: number) => {
      const [, init] = fetch.mock.calls[call] as [string, RequestInit];
      return (init.headers as Record<string, string>).authorization.replace("Bearer ", "");
    };
    expect(verifyBridgeToken(tokenAt(0), { secret })).toMatchObject({ runId: "run_1", skillId: "skill_1" });
    expect(verifyBridgeToken(tokenAt(1), { secret })).toMatchObject({ runId: "run_1", skillId: "skill_1" });
    vi.unstubAllGlobals();
  });
});
