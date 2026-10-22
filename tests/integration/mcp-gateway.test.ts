import { drizzle } from "drizzle-orm/postgres-js";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { agentAuthorizationDecisions, agentProfiles, agentRuns, runEvents, toolCalls } from "@/domains/agents/schema";
import { actionProposals, actionRevisions } from "@/domains/actions/schema";
import { issueDelegationGrant } from "@/domains/agents/delegation";
import { registerAgentPrincipal } from "@/domains/agents/principals";
import { ensureProfile } from "@/domains/agents/commands";
import { signBridgeToken } from "@/domains/agents/bridge-token";
import { signGatewayToken } from "@/domains/agents/gateway-token";
import { externalAccounts } from "@/domains/integrations/schema";
import { fixtureTransport, type FixtureRoute } from "../helpers/fixture-transport";
import type { GraphqlReadRequest, Transport, TransportRequest } from "@/domains/integrations/transport";
import { makeTestDb, ownerAuth, seedWorkspace } from "../helpers/test-workspace";

/*
 * The gateway door, against real Postgres. The bindings are only worth anything
 * if they re-read the database: these prove that a cancelled run, a foreign
 * run, a non-owner, and a mismatched session are all refused even when the
 * token itself is genuinely signed.
 *
 * The dispatch half is proved below with a fixture transport: a read returns
 * the provider shape, a send creates a proposal and never touches the
 * transport, and the limits and truncation behave as the plan states.
 *
 * Skipped unless TEST_DATABASE_URL points at a migrated scratch database.
 */

const handle = makeTestDb();
const suite = handle ? describe : describe.skip;
const holder: { db: ReturnType<typeof drizzle> | undefined } = { db: undefined };
vi.mock("@/lib/db", () => ({ get db() { return holder.db; } }));

/*
 * The route builds its gateway from `composioTransport` at import time, so the
 * fixture replaces that object rather than the gateway: every read still goes
 * through the same `Transport` interface the real one implements, and the spy
 * is the proof that a proposal path never calls a provider.
 */
const reads: TransportRequest[] = [];
const transportHolder: { transport: Transport | undefined } = { transport: undefined };
vi.mock("@/domains/integrations/transport", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/domains/integrations/transport")>();
  return {
    ...actual,
    composioTransport: {
      async read(request: TransportRequest) {
        reads.push(request);
        if (!transportHolder.transport) throw new Error("no fixture transport installed");
        return transportHolder.transport.read(request);
      },
      async graphql(request: GraphqlReadRequest) {
        if (!transportHolder.transport?.graphql) throw new Error("no fixture graphql transport installed");
        return transportHolder.transport.graphql(request);
      },
    } satisfies Transport,
  };
});

const SECRET = "g".repeat(40);
const NOW = new Date();

type Route = typeof import("@/app/api/mcp/route");
let route: Route;

beforeAll(async () => {
  if (!handle) return;
  holder.db = handle.db;
  process.env.EVE_GATEWAY_SECRET = SECRET;
  route = await import("@/app/api/mcp/route");
});

afterAll(async () => {
  delete process.env.EVE_GATEWAY_SECRET;
  await handle?.client?.end();
});

afterEach(() => {
  vi.unstubAllEnvs();
  // The unset-secret test deletes the variable; every other test needs it back.
  process.env.EVE_GATEWAY_SECRET = SECRET;
});

type Seeded = {
  state: (typeof agentRuns.$inferSelect)["state"];
  workspaceId: string;
  userId: string;
  runId: string;
  sessionRef: string;
};

async function seedRun(
  overrides: {
    state?: Seeded["state"];
    createdBy?: string | null;
    allowedTools?: string[];
    /** Issued before the run is inserted: the snapshot is frozen at admission. */
    grantScope?: { operations: string[]; accounts?: string[]; resources?: string[] };
  } = {},
): Promise<Seeded & { grantId?: string }> {
  const db = holder.db!;
  const slug = `gateway-${crypto.randomUUID()}`;
  const auth = await seedWorkspace(db, slug);
  // Through `ensureProfile`, exactly as a real start does: the snapshot the run
  // freezes is the profile's own list, so a capability missing from the default
  // and the backfill fails here rather than passing on a hand-seeded list.
  const profileId = await ensureProfile(auth.workspaceId);
  const [profile] = await db.select().from(agentProfiles).where(eq(agentProfiles.id, profileId)).limit(1);
  const grantId = overrides.grantScope ? await seedGrant(auth, overrides.grantScope) : undefined;
  const sessionRef = `wrun_${crypto.randomUUID()}`;
  const [run] = await db
    .insert(agentRuns)
    .values({
      workspaceId: auth.workspaceId,
      agentProfileId: profile.id,
      objective: "Fixture",
      state: overrides.state ?? "running",
      sessionRef,
      createdBy: overrides.createdBy === undefined ? auth.userId : overrides.createdBy,
      policySnapshot: {
        allowedTools: overrides.allowedTools ?? (profile.allowedTools as string[]),
        ...(grantId ? { grantId } : {}),
      },
    })
    .returning();
  return { state: run.state, workspaceId: auth.workspaceId, userId: auth.userId, runId: run.id, sessionRef, grantId };
}

/** A connected Gmail account; `status` is what revocation flips, the flags are the owner's switches. */
async function seedAccount(
  seed: Seeded,
  values: {
    alias: string;
    provider?: string;
    status?: "active" | "revoked" | "connecting";
    allowRead?: boolean;
    allowWrite?: boolean;
    accessTier?: string;
  } = { alias: "work-gmail" },
): Promise<string> {
  const id = `ca_${crypto.randomUUID()}`;
  await holder.db!.insert(externalAccounts).values({
    workspaceId: seed.workspaceId,
    provider: values.provider ?? "gmail",
    alias: values.alias,
    status: values.status ?? "active",
    composioConnectedAccountId: id,
    // Written explicitly so a test proves the flag it means to test; the schema
    // defaults remain the product's defaults, asserted in connector-permissions.
    ...(values.allowRead === undefined ? {} : { allowRead: values.allowRead }),
    ...(values.allowWrite === undefined ? {} : { allowWrite: values.allowWrite }),
    ...(values.accessTier === undefined ? {} : { accessTier: values.accessTier }),
  });
  return id;
}

function post(body: unknown, options: { token?: string | null; session?: string } = {}) {
  const headers = new Headers({ "content-type": "application/json" });
  const token = options.token === undefined ? null : options.token;
  if (token) headers.set("authorization", `Bearer ${token}`);
  if (options.session) headers.set("x-polymath-session", options.session);
  return route.POST(
    new Request("http://localhost/api/mcp", { method: "POST", headers, body: JSON.stringify(body) }),
  );
}

function tokenFor(seed: Seeded, options: { now?: Date; ttlSeconds?: number } = {}) {
  return signGatewayToken(
    { runId: seed.runId, userId: seed.userId, workspaceId: seed.workspaceId },
    { secret: SECRET, now: options.now ?? NOW, ttlSeconds: options.ttlSeconds },
  );
}

const listTools = { jsonrpc: "2.0", id: 1, method: "tools/list" };

suite("POST /api/mcp bindings (real Postgres)", () => {
  it("answers initialize and notifications/initialized for a bound run", async () => {
    const seed = await seedRun();
    const init = await post({ jsonrpc: "2.0", id: 1, method: "initialize" }, { token: tokenFor(seed) });
    expect(init.status).toBe(200);
    expect(await init.json()).toMatchObject({
      jsonrpc: "2.0",
      id: 1,
      result: { capabilities: { tools: {} }, serverInfo: { name: "polymath-gateway" } },
    });

    const notified = await post({ jsonrpc: "2.0", method: "notifications/initialized" }, { token: tokenFor(seed) });
    expect(notified.status).toBe(204);
  });

  it("returns the provider tool manifest for a running owned run", async () => {
    const seed = await seedRun();
    const response = await post(listTools, { token: tokenFor(seed) });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { result: { tools: Array<{ name: string; inputSchema: unknown }> } };
    expect(body.result.tools.map((tool) => tool.name).sort()).toEqual([
      "airtable_list_records",
      "asana_list_tasks",
      "calendly_list_events",
      "discord_list_channels",
      "github_read_issue",
      "github_search",
      "gmail_read_thread",
      "gmail_search",
      "gmail_send",
      "googlecalendar_list_events",
      "googledocs_list_documents",
      "googledrive_search_files",
      "googlesheets_list_sheets",
      "jira_search_issues",
      "linear_read_issue",
      "linear_search_issues",
      "slack_list_channels",
      "slack_read_channel",
      "trello_list_cards",
      "zoom_list_meetings",
    ]);
    expect(body.result.tools.every((tool) => typeof tool.inputSchema === "object")).toBe(true);
  });

  it("401s without a token, with a forged token, with an expired token, and with the bridge token", async () => {
    const seed = await seedRun();
    expect((await post(listTools)).status).toBe(401);
    expect((await post(listTools, { token: `${tokenFor(seed)}tampered` })).status).toBe(401);
    expect((await post(listTools, { token: tokenFor(seed, { now: new Date(NOW.getTime() - 120_000) }) })).status).toBe(401);
    const bridge = signBridgeToken(
      { userId: seed.userId, workspaceId: seed.workspaceId, role: "owner" },
      { secret: SECRET, now: NOW },
    );
    expect((await post(listTools, { token: bridge })).status).toBe(401);
  });

  it("401s when the user no longer holds an active membership", async () => {
    const seed = await seedRun();
    const token = tokenFor(seed);
    const { memberships } = await import("@/domains/identity/schema");
    const { eq } = await import("drizzle-orm");
    await holder.db!.update(memberships).set({ status: "suspended" }).where(eq(memberships.userId, seed.userId));
    expect((await post(listTools, { token })).status).toBe(401);
  });

  it("404s a run in another workspace with the same body as a missing run", async () => {
    const mine = await seedRun();
    const foreign = await seedRun();
    const foreignResponse = await post(listTools, {
      token: signGatewayToken(
        { runId: foreign.runId, userId: mine.userId, workspaceId: mine.workspaceId },
        { secret: SECRET, now: NOW },
      ),
    });
    const missingResponse = await post(listTools, {
      token: signGatewayToken(
        { runId: crypto.randomUUID(), userId: mine.userId, workspaceId: mine.workspaceId },
        { secret: SECRET, now: NOW },
      ),
    });
    expect(foreignResponse.status).toBe(404);
    expect(missingResponse.status).toBe(404);
    expect(await foreignResponse.json()).toEqual(await missingResponse.json());
  });

  it("403s when the token's user does not own the run", async () => {
    const seed = await seedRun();
    const other = await seedWorkspace(holder.db!, `gateway-other-${crypto.randomUUID()}`);
    const token = signGatewayToken(
      { runId: seed.runId, userId: other.userId, workspaceId: seed.workspaceId },
      { secret: SECRET, now: NOW },
    );
    // The other user is not a member of seed.workspaceId, so membership fails
    // first; add them as a viewer to isolate the ownership check.
    const { memberships } = await import("@/domains/identity/schema");
    await holder.db!.insert(memberships).values({
      workspaceId: seed.workspaceId,
      userId: other.userId,
      role: "viewer",
      status: "active",
    });
    const response = await post(listTools, { token });
    expect(response.status).toBe(403);
  });

  it("409s for a run that is no longer running", async () => {
    const seed = await seedRun({ state: "cancelled" });
    expect((await post(listTools, { token: tokenFor(seed) })).status).toBe(409);
  });

  it("403s when x-polymath-session names a different session", async () => {
    const seed = await seedRun();
    const token = tokenFor(seed);
    expect((await post(listTools, { token, session: seed.sessionRef })).status).toBe(200);
    expect((await post(listTools, { token, session: "wrun_someone_else" })).status).toBe(403);
  });

  it("returns an error for a tools/call whose tool is not in the catalog", async () => {
    const seed = await seedRun();
    const response = await post(
      { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "gmail_delete_all", arguments: {} } },
      { token: tokenFor(seed) },
    );
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ code: "not_found", status: 404 });
  });

  it("503s when the gateway secret is not configured", async () => {
    const seed = await seedRun();
    vi.stubEnv("EVE_GATEWAY_SECRET", "");
    delete process.env.EVE_GATEWAY_SECRET;
    expect((await post(listTools, { token: tokenFor(seed) })).status).toBe(503);
  });
});

/*
 * Dispatch: the part that turns an authorized invocation into a read or a
 * proposal. Every read below goes through the fixture transport; the send tests
 * assert `reads` stays empty, which is the structural claim that a model-driven
 * write can never reach a provider.
 */

const MESSAGES = "https://gmail.googleapis.com/gmail/v1/users/me/messages";
const THREADS = "https://gmail.googleapis.com/gmail/v1/users/me/threads";

const searchRoute: FixtureRoute = {
  method: "GET",
  endpointPrefix: MESSAGES,
  status: 200,
  body: {
    messages: [
      { id: "msg_fixture_alpha", threadId: "thr_fixture_alpha", snippet: "Fixture snippet alpha." },
      { id: "msg_fixture_beta", threadId: "thr_fixture_beta", snippet: "Fixture snippet beta." },
    ],
  },
};

function detailRoute(id: string, subject: string): FixtureRoute {
  return {
    method: "GET",
    endpointPrefix: `${MESSAGES}/${id}`,
    status: 200,
    body: {
      id,
      threadId: `thr_${id}`,
      payload: {
        mimeType: "text/plain",
        headers: [
          { name: "From", value: "fixture-sender@example.invalid" },
          { name: "Subject", value: subject },
          { name: "Date", value: "Mon, 20 Oct 2025 09:00:00 +0000" },
        ],
      },
    },
  };
}

function install(routes: FixtureRoute[]) {
  reads.length = 0;
  transportHolder.transport = fixtureTransport(routes);
}

function call(seed: Seeded, name: string, args: unknown) {
  return post(
    { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name, arguments: args } },
    { token: tokenFor(seed) },
  );
}

async function toolText(
  response: Response,
): Promise<{ text: string; parsed: { messages?: Array<{ id: string; from?: string | null; subject?: string | null }>; truncated?: boolean; returnedBytes?: number; status?: string; proposalId?: string; deduplicated?: boolean; bodyChanged?: boolean } }> {
  expect(response.status).toBe(200);
  const body = (await response.json()) as { result: { content: Array<{ type: string; text: string }> } };
  const text = body.result.content[0].text;
  return { text, parsed: JSON.parse(text) };
}

suite("tools/call dispatch (real Postgres)", () => {
  it("returns the fixture search shape", async () => {
    const seed = await seedRun();
    await seedAccount(seed);
    // Detail routes first: the fixture matches by `startsWith`, and the list
    // endpoint is a prefix of every detail endpoint.
    install([detailRoute("msg_fixture_alpha", "Alpha subject"), detailRoute("msg_fixture_beta", "Beta subject"), searchRoute]);

    const { parsed } = await toolText(await call(seed, "gmail_search", { query: "in:inbox", limit: 10 }));
    expect(parsed.messages).toHaveLength(2);
    expect(parsed.messages![0]).toMatchObject({
      id: "msg_fixture_alpha",
      from: "fixture-sender@example.invalid",
      subject: "Alpha subject",
    });
    expect(parsed.truncated).toBeUndefined();
  });

  it("clamps limit: 1000 to 100", async () => {
    const seed = await seedRun();
    await seedAccount(seed);
    install([{ ...searchRoute, body: { messages: [] } }]);

    await toolText(await call(seed, "gmail_search", { query: "in:inbox", limit: 1000 }));
    expect(reads[0].query?.maxResults).toBe("100");
  });

  it("403s a capability missing from the snapshot without fetching", async () => {
    const seed = await seedRun({ allowedTools: ["gmail.send"] });
    await seedAccount(seed);
    install([searchRoute]);

    const response = await call(seed, "gmail_search", { query: "x" });
    expect(response.status).toBe(403);
    expect(reads).toHaveLength(0);
  });

  it("403s a revoked account without fetching", async () => {
    const seed = await seedRun();
    await seedAccount(seed, { alias: "work-gmail", status: "revoked" });
    install([searchRoute]);

    const response = await call(seed, "gmail_search", { query: "x", accountAlias: "work-gmail" });
    expect(response.status).toBe(403);
    expect(reads).toHaveLength(0);
  });

  it("404s an unknown tool", async () => {
    const seed = await seedRun();
    install([]);
    const response = await call(seed, "linear_read_issues", {});
    expect(response.status).toBe(404);
  });

  /*
   * The connection's access tier. These prove the tier narrows the snapshot
   * rather than replacing it: the runs below carry the capability, so the only
   * thing that can refuse them is the connection. A refusal must happen before
   * a reservation, so `reads` staying empty is the structural proof that a
   * tier denial never calls a provider, and an empty toolCalls table is the
   * proof it spent no budget.
   */

  it("parks the run on the third identical call and refuses it", async () => {
    const seed = await seedRun();
    await seedAccount(seed, { alias: "work-gmail", accessTier: "read_send" });
    install([{ ...searchRoute, body: { messages: [] } }]);

    // Two identical calls are a retry and go through.
    await toolText(await call(seed, "gmail_search", { query: "same query" }));
    await toolText(await call(seed, "gmail_search", { query: "same query" }));
    expect(reads).toHaveLength(2);

    // The third is a loop: refused, no third provider call, run parked.
    const third = await call(seed, "gmail_search", { query: "same query" });
    expect(third.status).toBe(429);
    const body = (await third.json()) as { code: string };
    expect(body.code).toBe("loop_detected");
    expect(reads).toHaveLength(2);

    const [run] = await holder.db!.select().from(agentRuns).where(eq(agentRuns.id, seed.runId));
    expect(run.state).toBe("waiting_approval");

    // A different query from the parked run: the route refuses a run that is no
    // longer running, before the gateway is reached at all.
    const fourth = await call(seed, "gmail_search", { query: "other query" });
    expect(fourth.status).toBe(409);

    const loopEvents = await holder.db!
      .select()
      .from(runEvents)
      .where(eq(runEvents.runId, seed.runId));
    expect(loopEvents.filter((e) => e.type === "loop.detected")).toHaveLength(1);
  });

  it("counts failed calls toward the loop: three failed identical calls park the run", async () => {
    const seed = await seedRun();
    await seedAccount(seed, { alias: "work-gmail", accessTier: "read_send" });
    // The provider 500s. A model hammering a down provider with the same call
    // is spinning too, so the third attempt parks the run instead of the
    // provider seeing a fourth.
    install([{ ...searchRoute, status: 500, body: {} }]);

    const first = await call(seed, "gmail_search", { query: "x" });
    expect(first.status).toBe(502);
    const second = await call(seed, "gmail_search", { query: "x" });
    expect(second.status).toBe(502);
    const third = await call(seed, "gmail_search", { query: "x" });
    expect(third.status).toBe(429);
    const body = (await third.json()) as { code: string };
    expect(body.code).toBe("loop_detected");
  });

  it("creates one proposal and one revision for gmail_send, and never calls the transport", async () => {
    const seed = await seedRun({ allowedTools: ["gmail.send"] });
    await seedAccount(seed, { alias: "work-gmail", accessTier: "read_send" });
    install([searchRoute]);

    const args = {
      to: "recipient@example.invalid",
      subject: "Fixture subject",
      body: "Fixture body.",
      messageId: "msg_fixture_alpha",
      accountAlias: "work-gmail",
    };
    const { parsed } = await toolText(await call(seed, "gmail_send", args));
    expect(parsed.status).toBe("awaiting_review");
    expect(parsed.deduplicated).toBe(false);

    const proposals = await holder.db!
      .select()
      .from(actionProposals)
      .where(eq(actionProposals.workspaceId, seed.workspaceId));
    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toMatchObject({ status: "pending", riskClass: "external_write", runId: seed.runId });

    const revisions = await holder.db!
      .select()
      .from(actionRevisions)
      .where(eq(actionRevisions.proposalId, parsed.proposalId!));
    expect(revisions).toHaveLength(1);
    expect(revisions[0].revisionNumber).toBe(1);
    expect(revisions[0].payload).toMatchObject({
      to: args.to,
      subject: args.subject,
      body: args.body,
      inReplyTo: args.messageId,
      accountAlias: "work-gmail",
    });

    expect(reads).toHaveLength(0);
  });

  it("replays the same send as deduplicated with one revision", async () => {
    const seed = await seedRun({ allowedTools: ["gmail.send"] });
    await seedAccount(seed, { alias: "work-gmail", accessTier: "read_send" });
    install([]);

    const args = { to: "recipient@example.invalid", subject: "Replay", body: "Once.", messageId: "m1" };
    const first = await toolText(await call(seed, "gmail_send", args));
    const second = await toolText(await call(seed, "gmail_send", args));

    expect(first.parsed.deduplicated).toBe(false);
    expect(second.parsed).toMatchObject({ status: "awaiting_review", deduplicated: true });
    expect(second.parsed.proposalId).toBe(first.parsed.proposalId);

    const revisions = await holder.db!
      .select()
      .from(actionRevisions)
      .where(eq(actionRevisions.proposalId, first.parsed.proposalId!));
    expect(revisions).toHaveLength(1);
    expect(reads).toHaveLength(0);
  });

  it("reports bodyChanged when a dedupe hit stored different wording", async () => {
    const seed = await seedRun({ allowedTools: ["gmail.send"] });
    await seedAccount(seed, { alias: "work-gmail", accessTier: "read_send" });
    install([]);

    const base = { to: "recipient@example.invalid", subject: "Wording", messageId: "m1" };
    await toolText(await call(seed, "gmail_send", { ...base, body: "First draft." }));
    const second = await toolText(await call(seed, "gmail_send", { ...base, body: "Second wording." }));

    expect(second.parsed).toMatchObject({ status: "awaiting_review", deduplicated: true, bodyChanged: true });

    // The identical replay is silent: no bodyChanged, because nothing changed.
    const third = await toolText(await call(seed, "gmail_send", { ...base, body: "First draft." }));
    expect(third.parsed.bodyChanged).toBeUndefined();
    expect(reads).toHaveLength(0);
  });

  it("expires a gateway proposal after 24 hours", async () => {
    const seed = await seedRun({ allowedTools: ["gmail.send"] });
    await seedAccount(seed, { alias: "work-gmail", accessTier: "read_send" });
    install([]);

    const { parsed } = await toolText(
      await call(seed, "gmail_send", {
        to: "recipient@example.invalid",
        subject: "Expiry",
        body: "Body.",
        messageId: "m1",
      }),
    );
    const [row] = await holder.db!
      .select({ expiresAt: actionProposals.expiresAt })
      .from(actionProposals)
      .where(eq(actionProposals.id, parsed.proposalId!));
    const hours = (row.expiresAt!.getTime() - Date.now()) / 3_600_000;
    expect(hours).toBeGreaterThan(23.5);
    expect(hours).toBeLessThanOrEqual(24);
  });

  it("429s exactly one of two concurrent calls at 49 of 50", async () => {
    const seed = await seedRun();
    await seedAccount(seed);
    install([{ ...searchRoute, body: { messages: [] } }]);

    for (let n = 0; n < 49; n += 1) {
      await holder.db!.insert(toolCalls).values({
        workspaceId: seed.workspaceId,
        runId: seed.runId,
        toolName: "gmail_search",
        ok: true,
      });
    }

    // Both observe "one slot left" if the reservation is not taken under a
    // lock; the advisory lock plus the pending row must let exactly one through.
    const [a, b] = await Promise.all([
      call(seed, "gmail_search", { query: "one" }),
      call(seed, "gmail_search", { query: "two" }),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 429]);
  });

  it("429s the 51st provider call in a run", async () => {
    const seed = await seedRun();
    await seedAccount(seed);
    install([{ ...searchRoute, body: { messages: [] } }]);

    for (let n = 0; n < 50; n += 1) {
      await holder.db!.insert(toolCalls).values({
        workspaceId: seed.workspaceId,
        runId: seed.runId,
        toolName: "gmail_search",
        ok: true,
      });
    }

    const response = await call(seed, "gmail_search", { query: "x" });
    expect(response.status).toBe(429);
    const body = (await response.json()) as { code: string };
    expect(body.code).toBe("run_capability_limit");
    expect(reads).toHaveLength(0);
  });

  it("reads GitHub and Slack through the same gates, and an unconnected provider fails closed", async () => {
    const seed = await seedRun();
    // No GitHub account yet: the Gmail connection must not satisfy a GitHub tool.
    await seedAccount(seed);
    install([]);
    const denied = await call(seed, "github_search", { query: "repo:o/r is:open" });
    expect(denied.status).toBe(403);
    expect(((await denied.json()) as { code: string }).code).toBe("account_not_connected");
    expect(reads).toHaveLength(0);

    await seedAccount(seed, { alias: "work-github", provider: "github" });
    await seedAccount(seed, { alias: "team-slack", provider: "slack" });
    install([
      {
        method: "GET",
        endpointPrefix: "https://api.github.com/search/issues",
        status: 200,
        body: { items: [{ number: 3, title: "Bug", state: "open", html_url: "https://github.com/o/r/issues/3" }] },
      },
      {
        method: "GET",
        endpointPrefix: "https://slack.com/api/conversations.history",
        status: 200,
        body: { ok: false, error: "not_in_channel" },
      },
    ]);
    const search = await call(seed, "github_search", { query: "repo:o/r is:open" });
    expect(search.status).toBe(200);
    const searchBody = JSON.parse(((await search.json()) as { result: { content: Array<{ text: string }> } }).result.content[0].text) as {
      items: Array<{ number: number }>;
    };
    expect(searchBody.items[0].number).toBe(3);

    // Slack's HTTP-200 ok:false is a labelled failure, never an empty success.
    const history = await call(seed, "slack_read_channel", { channel: "C0123ABCD" });
    expect(history.status).toBe(502);
    expect(((await history.json()) as { code: string }).code).toBe("provider_error");

    // A path-shaped repository name never reaches the transport.
    const before = reads.length;
    const bad = await call(seed, "github_read_issue", { owner: "..", repo: "r", number: 1 });
    expect(bad.status).toBe(400);
    expect(reads).toHaveLength(before);
  });

  it("reads Linear through a constant query and refuses an identifier that is not one", async () => {
    const seed = await seedRun();
    await seedAccount(seed, { alias: "work-linear", provider: "linear" });
    install([
      {
        method: "GRAPHQL",
        endpointPrefix: "https://api.linear.app/graphql#PolymathReadIssue",
        status: 200,
        body: { issue: { identifier: "ASH-1", title: "T", state: { name: "Todo" }, comments: { nodes: [] }, labels: { nodes: [] } } },
      },
    ]);
    const ok = await call(seed, "linear_read_issue", { identifier: "ASH-1" });
    expect(ok.status).toBe(200);
    const bad = await call(seed, "linear_read_issue", { identifier: "ASH-1) { id } mutation x" });
    expect(bad.status).toBe(400);
  });

  it("truncates a 70 KB thread at the last whole message with an explicit marker", async () => {
    // No `allowedTools` override: the profile is ensured the way a real start
    // creates it, so this proves `gmail.thread.read` reaches the snapshot.
    const seed = await seedRun();
    await seedAccount(seed);
    // Two ~40 KB bodies: the first fits inside the 64 KiB bound, the pair does not.
    const bigBody = Buffer.from("x".repeat(40 * 1024), "utf8").toString("base64url");
    install([
      {
        method: "GET",
        endpointPrefix: THREADS,
        status: 200,
        body: {
          messages: [
            {
              id: "msg_big_one",
              threadId: "thr_big",
              payload: {
                mimeType: "text/plain",
                headers: [{ name: "Subject", value: "One" }],
                body: { data: bigBody },
              },
            },
            {
              id: "msg_big_two",
              threadId: "thr_big",
              payload: {
                mimeType: "text/plain",
                headers: [{ name: "Subject", value: "Two" }],
                body: { data: bigBody },
              },
            },
          ],
        },
      },
    ]);

    const { text, parsed } = await toolText(await call(seed, "gmail_read_thread", { threadId: "thr_big" }));
    expect(parsed.truncated).toBe(true);
    expect(parsed.messages).toHaveLength(1);
    expect(parsed.messages![0].id).toBe("msg_big_one");
    expect(parsed.returnedBytes).toBe(Buffer.byteLength(text, "utf8"));
    expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(65_536);
  });
});

/*
 * The grant branch. A run that names a grant is authorized by that grant as
 * well as by its snapshot, and every verdict - allow and deny - is written.
 *
 * Runs without a grant are the gap named in the plan's open questions: the
 * decision log's `grant_id` is NOT NULL, so those runs are gated by the
 * snapshot and bindings alone and leave no decision row. That is asserted
 * below so the gap cannot silently widen.
 */

async function seedGrant(
  auth: { userId: string; workspaceId: string },
  scope: { operations: string[]; accounts?: string[] },
): Promise<string> {
  const owner = ownerAuth(auth.userId, auth.workspaceId);
  const principal = await registerAgentPrincipal(owner, { key: "alfred", kind: "agent", label: "Alfred" });
  const grant = await issueDelegationGrant(owner, {
    agentPrincipalId: principal.principalId,
    scope,
    expiresAt: new Date(Date.now() + 3600_000),
  });
  return grant.grantId;
}

suite("tools/call with a delegation grant (real Postgres)", () => {
  it("admits a granted read and records an allowed decision", async () => {
    const seed = await seedRun({ grantScope: { operations: ["integration.use"], accounts: ["work-gmail"] } });
    await seedAccount(seed);
    install([{ ...searchRoute, body: { messages: [] } }]);

    const response = await call(seed, "gmail_search", { query: "x", accountAlias: "work-gmail" });
    expect(response.status).toBe(200);

    const decisions = await holder.db!
      .select()
      .from(agentAuthorizationDecisions)
      .where(eq(agentAuthorizationDecisions.grantId, seed.grantId!));
    expect(decisions).toHaveLength(1);
    expect(decisions[0].decision).toBe("allowed");
  });

  it("denies a granted read outside the grant's accounts, records it, and fetches nothing", async () => {
    const seed = await seedRun({ grantScope: { operations: ["integration.use"], accounts: ["other-gmail"] } });
    await seedAccount(seed);
    install([searchRoute]);

    const response = await call(seed, "gmail_search", { query: "x", accountAlias: "work-gmail" });
    expect(response.status).toBe(403);

    const decisions = await holder.db!
      .select()
      .from(agentAuthorizationDecisions)
      .where(eq(agentAuthorizationDecisions.grantId, seed.grantId!));
    expect(decisions).toHaveLength(1);
    expect(decisions[0].decision).toBe("denied");
    expect(decisions[0].reasons).toContain("account_not_granted");
    expect(reads).toHaveLength(0);
  });

  it("denies a thread read outside the grant's resource bound, and admits the one it names", async () => {
    const seed = await seedRun({
      grantScope: {
        operations: ["integration.use"],
        accounts: ["work-gmail"],
        resources: ["thread:thr_allowed"],
      },
    });
    await seedAccount(seed);
    install([
      {
        method: "GET",
        endpointPrefix: THREADS,
        status: 200,
        body: { messages: [] },
      },
    ]);

    const denied = await call(seed, "gmail_read_thread", { threadId: "thr_other", accountAlias: "work-gmail" });
    expect(denied.status).toBe(403);
    expect(reads).toHaveLength(0);

    const allowed = await call(seed, "gmail_read_thread", { threadId: "thr_allowed", accountAlias: "work-gmail" });
    expect(allowed.status).toBe(200);
    expect(reads).toHaveLength(1);

    const decisions = await holder.db!
      .select()
      .from(agentAuthorizationDecisions)
      .where(eq(agentAuthorizationDecisions.grantId, seed.grantId!));
    expect(decisions.map((d) => d.decision).sort()).toEqual(["allowed", "denied"]);
    expect(decisions.find((d) => d.decision === "denied")?.reasons).toContain("resource_not_granted");
  });

  it("writes no decision row for a grantless run", async () => {
    const seed = await seedRun();
    await seedAccount(seed);
    install([{ ...searchRoute, body: { messages: [] } }]);

    expect((await call(seed, "gmail_search", { query: "x" })).status).toBe(200);
    const decisions = await holder.db!
      .select()
      .from(agentAuthorizationDecisions)
      .where(eq(agentAuthorizationDecisions.runId, seed.runId));
    expect(decisions).toHaveLength(0);
  });
});


/*
 * Tier enforcement (0229 + PROVIDER_TIERS): the snapshot bounds what the run
 * may want; the connection's tier bounds what this connection grants. The
 * tier is read live with the account on every call, so a mid-run flip bites
 * the very next call.
 */
suite("tools/call tier gate (real Postgres)", () => {
  it("denies a send above the tier, pointing at the tier control, and spends nothing", async () => {
    const seed = await seedRun({ allowedTools: ["gmail.send"] });
    await seedAccount(seed, { alias: "work-gmail", accessTier: "read_only" });
    install([]);

    const response = await call(seed, "gmail_send", {
      to: "recipient@example.invalid",
      subject: "Blocked",
      body: "Body.",
      messageId: "m1",
      accountAlias: "work-gmail",
    });
    expect(response.status).toBe(403);
    const body = (await response.json()) as { code: string; title: string };
    expect(body.code).toBe("permission_denied");
    expect(body.title).toBe(
      'Agent access for "work-gmail" does not include this. Raise the tier in Connectors.',
    );
    expect(reads).toHaveLength(0);

    // The tier gate sits before budget reservation: a denial is free.
    const calls = await holder.db!
      .select()
      .from(toolCalls)
      .where(eq(toolCalls.runId, seed.runId));
    expect(calls).toHaveLength(0);
  });

  it("passes a read within the tier through to the provider", async () => {
    const seed = await seedRun();
    await seedAccount(seed, { alias: "work-gmail", accessTier: "read_only" });
    install([{ ...searchRoute, body: { messages: [] } }]);

    const { parsed } = await toolText(await call(seed, "gmail_search", { query: "x" }));
    expect(parsed.messages).toEqual([]);
    expect(reads).toHaveLength(1);
  });

  it("reads the tier live, so a mid-run flip bites on the next call", async () => {
    const seed = await seedRun({ allowedTools: ["gmail.send"] });
    await seedAccount(seed, { alias: "work-gmail", accessTier: "read_send" });
    install([]);

    const allowed = await toolText(
      await call(seed, "gmail_send", {
        to: "recipient@example.invalid",
        subject: "Allowed",
        body: "Body.",
        messageId: "m1",
        accountAlias: "work-gmail",
      }),
    );
    expect(allowed.parsed.status).toBe("awaiting_review");

    // The owner lowers the tier while the run is in flight; the next call is
    // refused because the tier is re-read with the account, not copied into
    // the run's snapshot.
    await holder.db!
      .update(externalAccounts)
      .set({ accessTier: "read_only" })
      .where(eq(externalAccounts.workspaceId, seed.workspaceId));

    const denied = await call(seed, "gmail_send", {
      to: "recipient@example.invalid",
      subject: "Blocked now",
      body: "Body.",
      messageId: "m2",
      accountAlias: "work-gmail",
    });
    expect(denied.status).toBe(403);
    const body = (await denied.json()) as { code: string; title: string };
    expect(body.code).toBe("permission_denied");
    expect(body.title).toContain("Agent access");
    expect(body.title).toContain("Connectors");
    expect(reads).toHaveLength(0);
  });

  it("keeps two unaliased accounts of different tiers ambiguous", async () => {
    const seed = await seedRun({ allowedTools: ["gmail.send"] });
    await seedAccount(seed, { alias: "a-gmail", accessTier: "read_only" });
    await seedAccount(seed, { alias: "b-gmail", accessTier: "read_send" });
    install([]);

    const response = await call(seed, "gmail_send", {
      to: "recipient@example.invalid",
      subject: "Which one",
      body: "Body.",
      messageId: "m1",
    });
    expect(response.status).toBe(403);
    const body = (await response.json()) as { code: string };
    expect(body.code).toBe("ambiguous_account");
    expect(reads).toHaveLength(0);
  });
});
