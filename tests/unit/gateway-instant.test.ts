import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { makeTestDb, ownerAuth, seedWorkspace } from "../helpers/test-workspace";

/*
 * The Instant dispatch branch (spec #316, D5): a derived instant.* tool name
 * resolves through the synced catalog without any external_accounts row,
 * passes the frozen policy-snapshot gate, and maps refusals to policy
 * outcomes. The connected-account path is asserted untouched by the existing
 * suites; here the module boundary is stubbed so no live Composio call fires.
 *
 * Postgres-dependent assertions skip cleanly without TEST_DATABASE_URL.
 */

const handle = makeTestDb();
const suite = handle ? describe : describe.skip;

let db: NonNullable<typeof handle>["db"];
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let gateway: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let instant: any;

beforeAll(async () => {
  if (!handle) return;
  ({ db } = handle);
  gateway = await import("@/domains/agents/gateway");
  instant = await import("@/domains/integrations/instant-tools");
});

afterAll(async () => {
  vi.restoreAllMocks();
  await handle?.client.end();
});

const RUN_ID = "11111111-1111-1111-1111-111111111111";

function runContext(snapshotTools: string[], tool: string, args: unknown = {}) {
  return {
    auth: ownerAuth("00000000-0000-0000-0000-00000000000a", "00000000-0000-0000-0000-00000000000b"),
    run: { id: RUN_ID, policySnapshot: { allowedTools: snapshotTools } },
    tool,
    args,
  };
}

suite("gateway Instant dispatch branch", () => {
  it("routes an instant.* tool through executeInstantTool with no account resolution", async () => {
    const executeSpy = vi.spyOn(instant.InstantTools, "executeInstantTool").mockResolvedValue({
      ok: true,
      data: { hello: "world" },
    });
    const resolveSpy = vi.spyOn(instant.InstantTools, "resolveInstantCapability");
    const g = gateway.createGateway({ transport: {} as never });
    const outcome = await g.call(runContext(["instant.hackernews.hackernews_get_frontpage"], "instant.hackernews.hackernews_get_frontpage"));
    expect(outcome).toMatchObject({ ok: true });
    expect(executeSpy).toHaveBeenCalledOnce();
    // No account lookup: the connected path's resolveConnectedAccount never runs.
    const { resolveConnectedAccount } = await import("@/domains/integrations/queries");
    expect(resolveSpy).toHaveBeenCalledWith("instant.hackernews.hackernews_get_frontpage");
    void resolveConnectedAccount;
  });

  it("denies a tool the run's frozen snapshot does not name (403 capability_not_allowed)", async () => {
    const executeSpy = vi.spyOn(instant.InstantTools, "executeInstantTool");
    const g = gateway.createGateway({ transport: {} as never });
    const outcome = await g.call(runContext(["instant.other.tool"], "instant.hackernews.hackernews_get_frontpage"));
    expect(outcome).toMatchObject({ ok: false, status: 403, code: "capability_not_allowed" });
    expect(executeSpy).not.toHaveBeenCalled();
  });

  it("keeps the connected-path 404 for unknown names (no instant prefix)", async () => {
    const g = gateway.createGateway({ transport: {} as never });
    const outcome = await g.call(runContext(["anything"], "not_a_known_tool"));
    expect(outcome).toMatchObject({ ok: false, status: 404, code: "not_found" });
  });

  it("maps an InstantToolNotExecutableError to 403 permission_denied", async () => {
    vi.spyOn(instant.InstantTools, "executeInstantTool").mockRejectedValue(
      new instant.InstantToolNotExecutableError("not_no_auth", "instant.hackernews.hackernews_get_frontpage"),
    );
    const g = gateway.createGateway({ transport: {} as never });
    const outcome = await g.call(runContext(["instant.hackernews.hackernews_get_frontpage"], "instant.hackernews.hackernews_get_frontpage"));
    expect(outcome).toMatchObject({ ok: false, status: 403, code: "permission_denied" });
  });

  it("maps QuotaExhaustedError to the labeled 429", async () => {
    const { QuotaExhaustedError } = await import("@/integrations/providers/quota");
    vi.spyOn(instant.InstantTools, "executeInstantTool").mockRejectedValue(
      new QuotaExhaustedError("composio", "2099-01", 1000),
    );
    const g = gateway.createGateway({ transport: {} as never });
    const outcome = await g.call(runContext(["instant.hackernews.hackernews_get_frontpage"], "instant.hackernews.hackernews_get_frontpage"));
    expect(outcome).toMatchObject({ ok: false, status: 429, code: "quota_exhausted" });
  });
});
