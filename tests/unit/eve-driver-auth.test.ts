import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEveDriver, eveBridgeUnavailableReason } from "@/domains/agents/eve-driver";
import { verifyBridgeToken } from "@/domains/agents/bridge-token";
import { signBridgeToken } from "@/domains/agents/bridge-token";

const mocks = vi.hoisted(() => ({ update: vi.fn(), localDev: vi.fn(() => async () => null) }));
const SECRET = "t".repeat(40);
const auth = { userId: "user-1", workspaceId: "ws-1", role: "member" as const };
// Every export the channel and driver reach. A mock factory replaces the whole
// module, so an export missing here is `undefined` at the call site rather than
// a link error — which is how a stale mock breaks a test that never changed.
vi.mock("@/domains/identity/resolve", () => ({
  resolveAuthContext: vi.fn(),
  verifyWorkspaceBinding: vi.fn(),
  activeMembershipRole: vi.fn(),
}));
vi.mock("@/lib/db", () => ({ db: { update: mocks.update } }));
vi.mock("eve/channels/eve", () => ({ eveChannel: (config: unknown) => config }));
vi.mock("eve/channels/auth", () => ({ localDev: mocks.localDev }));

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("EVE_BASE_URL", "http://eve.fixture");
  vi.stubEnv("EVE_BRIDGE_SECRET", SECRET);
  mocks.update.mockReturnValue({ set: () => ({ where: async () => [] }) });
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

const input = () => ({
  sessionId: "run-uuid", auth, objective: "Read tasks", instructions: null,
  policy: { profileId: "profile", model: "m", allowedTools: ["tasks.read"], allowedAccounts: [], budgetUsd: {}, auth },
});

describe("verified workspace binding to Eve", () => {
  it("reports unavailable and makes no HTTP call without a bridge secret", async () => {
    vi.stubEnv("EVE_BRIDGE_SECRET", "");
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    expect(eveBridgeUnavailableReason()).toContain("EVE_BRIDGE_SECRET");
    await expect(createEveDriver().start(input())).rejects.toThrow("EVE_BRIDGE_SECRET");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("start sends a signed bearer for the caller's workspace, no spike header, and a stable operationId", async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json({ sessionId: "wrun_1" }, { status: 202 }));
    vi.stubGlobal("fetch", fetch);
    await createEveDriver().start(input());
    const [url, init] = fetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://eve.fixture/eve/v1/session");
    const headers = init.headers as Record<string, string>;
    expect(headers["x-spike-clerk-user-id"]).toBeUndefined();
    const claims = verifyBridgeToken(headers.authorization.replace("Bearer ", ""), { secret: SECRET });
    // Every token for a run names it: the skill resolver needs the run even
    // when the run pinned no skill. It also carries the run's frozen model, so
    // the agent runs the model the run row prices.
    expect(claims).toEqual({ ...auth, runId: "run-uuid", model: "m" });
    expect(JSON.parse(String(init.body))).toMatchObject({ message: "Read tasks", operationId: "axiom-run-run-uuid" });
    expect(mocks.update).toHaveBeenCalledOnce();
  });

  it("the Eve channel refuses spike headers, missing tokens and unverifiable members", async () => {
    vi.resetModules();
    const { authenticators } = await import("../../eve/polymath/agent/channels/eve");
    const bridge = authenticators[0];
    const { verifyWorkspaceBinding: verify } = await import("@/domains/identity/resolve");
    expect(await bridge(new Request("https://eve.test/s", { headers: { "x-spike-clerk-user-id": "dev-user" } }))).toBeNull();
    expect(verify).not.toHaveBeenCalled();

    const token = signBridgeToken(auth, { secret: SECRET });
    vi.mocked(verify).mockResolvedValueOnce(null);
    expect(await bridge(new Request("https://eve.test/s", { headers: { authorization: `Bearer ${token}` } }))).toBeNull();
    vi.mocked(verify).mockResolvedValueOnce(auth);
    expect(await bridge(new Request("https://eve.test/s", { headers: { authorization: `Bearer ${token}` } }))).toMatchObject({
      attributes: { workspaceId: "ws-1" }, principalId: "user-1",
    });
    expect(await bridge(new Request("https://eve.test/s", { headers: { authorization: "Bearer v1.bad.token" } }))).toBeNull();
  });

  it("start sends the run's frozen model in the signed claims", async () => {
    // The run row freezes a model at start, and the agent must run THAT model:
    // an unsent model silently fell back to the default, so a run recorded
    // mercury-3 while Gemini answered and billed. The claim is the only channel
    // that reaches the model resolver before the first step.
    const fetch = vi.fn().mockResolvedValue(Response.json({ sessionId: "wrun_1" }, { status: 202 }));
    vi.stubGlobal("fetch", fetch);
    await createEveDriver().start({ ...input(), policy: { ...input().policy, model: "mercury-3" } });
    const headers = (fetch.mock.calls[0] as [string, RequestInit])[1].headers as Record<string, string>;
    const claims = verifyBridgeToken(headers.authorization.replace("Bearer ", ""), { secret: SECRET });
    expect(claims).toEqual({ ...auth, runId: "run-uuid", model: "mercury-3" });
  });

  it("start omits the model claim when the run froze none", async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json({ sessionId: "wrun_1" }, { status: 202 }));
    vi.stubGlobal("fetch", fetch);
    await createEveDriver().start({ ...input(), policy: { ...input().policy, model: null } });
    const headers = (fetch.mock.calls[0] as [string, RequestInit])[1].headers as Record<string, string>;
    const claims = verifyBridgeToken(headers.authorization.replace("Bearer ", ""), { secret: SECRET });
    // Byte-compatible with tokens minted before this claim existed.
    expect(claims).toEqual({ ...auth, runId: "run-uuid" });
  });

  it("the Eve channel publishes the model claim as a session attribute", async () => {
    vi.resetModules();
    const { authenticators } = await import("../../eve/polymath/agent/channels/eve");
    const bridge = authenticators[0];
    const { verifyWorkspaceBinding: verify } = await import("@/domains/identity/resolve");
    vi.mocked(verify).mockResolvedValueOnce(auth);
    const token = signBridgeToken({ ...auth, runId: "run-uuid", model: "mercury-3" }, { secret: SECRET });
    const result = await bridge(new Request("https://eve.test/s", { headers: { authorization: `Bearer ${token}` } }));
    expect(result).toMatchObject({
      attributes: { workspaceId: "ws-1", runId: "run-uuid", model: "mercury-3" },
    });
  });

  it("production never mounts localDev", async () => {
    vi.resetModules();
    vi.stubEnv("NODE_ENV", "production");
    const { authenticators } = await import("../../eve/polymath/agent/channels/eve");
    expect(authenticators).toHaveLength(1);
    expect(mocks.localDev).not.toHaveBeenCalled();
  });
});
