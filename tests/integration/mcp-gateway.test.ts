import { drizzle } from "drizzle-orm/postgres-js";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { agentProfiles, agentRuns } from "@/domains/agents/schema";
import { signBridgeToken } from "@/domains/agents/bridge-token";
import { signGatewayToken } from "@/domains/agents/gateway-token";
import { makeTestDb, seedWorkspace } from "../helpers/test-workspace";

/*
 * The gateway door, against real Postgres. The bindings are only worth anything
 * if they re-read the database: these prove that a cancelled run, a foreign
 * run, a non-owner, and a mismatched session are all refused even when the
 * token itself is genuinely signed.
 *
 * Skipped unless TEST_DATABASE_URL points at a migrated scratch database.
 */

const handle = makeTestDb();
const suite = handle ? describe : describe.skip;
const holder: { db: ReturnType<typeof drizzle> | undefined } = { db: undefined };
vi.mock("@/lib/db", () => ({ get db() { return holder.db; } }));

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

async function seedRun(overrides: { state?: Seeded["state"]; createdBy?: string | null } = {}): Promise<Seeded> {
  const db = holder.db!;
  const slug = `gateway-${crypto.randomUUID()}`;
  const auth = await seedWorkspace(db, slug);
  const [profile] = await db
    .insert(agentProfiles)
    .values({ workspaceId: auth.workspaceId, name: "alfred" })
    .returning();
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
      policySnapshot: { allowedTools: ["gmail.read"] },
    })
    .returning();
  return { state: run.state, workspaceId: auth.workspaceId, userId: auth.userId, runId: run.id, sessionRef };
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
      "gmail_read_thread",
      "gmail_search",
      "gmail_send",
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

  it("returns method_not_found for tools/call until dispatch lands", async () => {
    const seed = await seedRun();
    const response = await post(
      { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "gmail_search", arguments: { query: "x" } } },
      { token: tokenFor(seed) },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ id: 7, error: { code: -32601 } });
  });

  it("503s when the gateway secret is not configured", async () => {
    const seed = await seedRun();
    vi.stubEnv("EVE_GATEWAY_SECRET", "");
    delete process.env.EVE_GATEWAY_SECRET;
    expect((await post(listTools, { token: tokenFor(seed) })).status).toBe(503);
  });
});
