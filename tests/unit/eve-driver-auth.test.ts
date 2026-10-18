import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveAuthContext } from "@/domains/identity/resolve";
import { createEveDriver, eveBridgeUnavailableReason } from "@/domains/agents/eve-driver";
import { createEngine } from "@/domains/agents/engine";
import { POST } from "@/app/api/v1/runs/route";

const mocks = vi.hoisted(() => ({
  configured: false,
  update: vi.fn(),
  start: vi.fn(),
  localDev: vi.fn(() => async () => null),
}));
const owner = { userId: "internal-dev-owner", workspaceId: "dev-workspace", role: "owner" as const };
vi.mock("@/lib/clerk", () => ({ get clerkConfigured() { return mocks.configured; } }));
vi.mock("@/domains/identity/resolve", () => ({ resolveAuthContext: vi.fn() }));
vi.mock("@/lib/db", () => ({ db: { update: mocks.update } }));
vi.mock("@/domains/agents/engine", () => ({ createEngine: vi.fn(() => ({ start: mocks.start })) }));
vi.mock("@/domains/agents/commands", () => ({ ensureProfile: vi.fn() }));
vi.mock("@/domains/agents/queries", () => ({ listRecentRuns: vi.fn() }));
vi.mock("@/lib/auth", () => ({
  authedHandler: (handler: (auth: typeof owner, request: Request) => Promise<Response>) => (request: Request) => handler(owner, request),
}));
vi.mock("eve/channels/eve", () => ({ eveChannel: (config: unknown) => config }));
vi.mock("eve/channels/auth", () => ({ localDev: mocks.localDev }));

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("NODE_ENV", "development");
  vi.stubEnv("EVE_BASE_URL", "http://eve.fixture");
  mocks.configured = false;
  vi.mocked(resolveAuthContext).mockResolvedValue(owner);
  mocks.update.mockReturnValue({ set: () => ({ where: async () => [] }) });
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

const input = () => ({
  sessionId: "run-uuid", auth: owner, objective: "Read tasks", instructions: null,
  policy: { profileId: "profile", model: "captured-model", allowedTools: ["tasks.read"], allowedAccounts: [], budgetUsd: {}, auth: owner },
});

describe("development-only Eve identity transport", () => {
  it.each(["production", "clerk"])("blocks %s before any HTTP call or identity provisioning", async (mode) => {
    if (mode === "production") vi.stubEnv("NODE_ENV", "production");
    else mocks.configured = true;
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    expect(eveBridgeUnavailableReason()).toContain("verified Clerk identity");
    await expect(createEveDriver().start(input())).rejects.toThrow("verified Clerk identity");
    expect(fetch).not.toHaveBeenCalled();
    expect(resolveAuthContext).not.toHaveBeenCalled();
  });

  it("rejects a real/different AuthContext rather than assigning it to the dev owner", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await expect(createEveDriver().start({ ...input(), auth: { ...owner, userId: "real-user" } })).rejects.toThrow("another identity");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("preserves the intentionally local development spike for the matched dev owner", async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json({ sessionId: "wrun_fixture" }, { status: 202 }));
    vi.stubGlobal("fetch", fetch);
    await createEveDriver().start(input());
    expect(fetch).toHaveBeenCalledWith("http://eve.fixture/eve/v1/session", expect.objectContaining({
      headers: expect.objectContaining({ "x-spike-clerk-user-id": "dev-user" }),
    }));
    expect(mocks.update).toHaveBeenCalledOnce();
  });

  it("the run endpoint reports unsupported transport without starting/reserving a run", async () => {
    mocks.configured = true;
    const response = await POST(new Request("https://axiom.test/api/v1/runs", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ objective: "Read tasks" }),
    }), undefined);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: "agent_bridge_unavailable", title: expect.stringContaining("verified Clerk identity") });
    expect(createEngine).not.toHaveBeenCalled();
    expect(mocks.start).not.toHaveBeenCalled();
  });

  it.each(["production", "clerk"])("the Eve channel rejects spike headers and omits localDev in %s", async (mode) => {
    vi.resetModules();
    if (mode === "production") vi.stubEnv("NODE_ENV", "production");
    else mocks.configured = true;
    const { default: definition } = await import("../../eve/alfred/agent/channels/eve");
    const channel = definition as unknown as { auth: Array<(request: Request) => Promise<unknown>> };
    expect(mocks.localDev).not.toHaveBeenCalled();
    expect(channel.auth).toHaveLength(1);
    expect(await channel.auth[0](new Request("https://eve.test/session", { headers: { "x-spike-clerk-user-id": "dev-user" } }))).toBeNull();
    expect(resolveAuthContext).not.toHaveBeenCalled();
  });
});
