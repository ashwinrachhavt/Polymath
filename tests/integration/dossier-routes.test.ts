import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { agentRuns } from "@/domains/agents/schema";
import { documents, dossiers } from "@/domains/knowledge/schema";
import { makeTestDb, seedWorkspace } from "../helpers/test-workspace";

/*
 * The dossier HTTP surface end to end: auth mock at the boundary, real routes,
 * real Postgres. The domain invariants (pinning, scoping) live in
 * dossiers.test.ts; this file proves the routes parse, scope, and answer in
 * problems+json when they fail.
 */

const handle = makeTestDb();
const suite = handle ? describe : describe.skip;
const holder: { db: ReturnType<typeof drizzle> | undefined; auth: { userId: string; workspaceId: string; role: "owner" } | undefined } = {
  db: undefined,
  auth: undefined,
};
vi.mock("@/lib/db", () => ({ get db() { return holder.db; } }));
vi.mock("@/lib/db-transaction", () => ({
  get withTransaction() {
    return (fn: Parameters<typeof import("@/lib/db-transaction").withTransaction>[0]) =>
      (holder.db!.transaction as typeof import("@/lib/db-transaction").withTransaction)(fn);
  },
}));
vi.mock("@/lib/auth", () => ({
  authedHandler: (handler: (auth: NonNullable<typeof holder.auth>, request: Request, ctx: unknown) => Promise<Response>) =>
    (request: Request, ctx: unknown) => handler(holder.auth!, request, ctx),
}));

import { GET, POST } from "@/app/api/v1/dossiers/route";
import { POST as GENERATE } from "@/app/api/v1/dossiers/[dossierId]/generate/route";

let a: { userId: string; workspaceId: string };
let b: { userId: string; workspaceId: string };
let eveCalls: Array<{ url: string; init: RequestInit }> = [];

const json = (body: unknown) => ({ method: "POST" as const, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const listDossiers = () => GET(new Request("https://axiom.test/api/v1/dossiers"), undefined as never);
const createDossier = (body: unknown) => POST(new Request("https://axiom.test/api/v1/dossiers", json(body)), undefined as never);
const generate = (dossierId: string, body: unknown) =>
  GENERATE(new Request(`https://axiom.test/api/v1/dossiers/${dossierId}/generate`, json(body)), {
    params: Promise.resolve({ dossierId }),
  } as never);

async function addDocument(workspaceId: string, userId: string, title: string): Promise<string> {
  const [doc] = await holder.db!.insert(documents)
    .values({ workspaceId, title, createdBy: userId, updatedBy: userId })
    .returning({ id: documents.id });
  return doc.id;
}

beforeAll(async () => {
  holder.db = handle?.db;
  a = await seedWorkspace(handle!.db, `drt-${crypto.randomUUID()}`);
  b = await seedWorkspace(handle!.db, `drt-${crypto.randomUUID()}`);
  holder.auth = { ...a, role: "owner" };
});
afterAll(async () => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); await handle?.client.end(); });
beforeEach(() => {
  eveCalls = [];
  holder.auth = { ...a, role: "owner" };
  vi.stubEnv("EVE_BASE_URL", "http://eve.fixture");
  vi.stubEnv("EVE_BRIDGE_SECRET", "q".repeat(40));
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
    eveCalls.push({ url, init });
    return Response.json({ sessionId: `wrun_${eveCalls.length}` }, { status: 202 });
  }));
});

suite("dossier routes (real Postgres)", () => {
  it("creates a dossier and lists it with its document count", async () => {
    const docId = await addDocument(a.workspaceId, a.userId, "Lease");
    const created = await createDossier({ name: "Rental papers", documentIds: [docId] });
    expect(created.status).toBe(201);
    const { dossier } = await created.json();
    expect(dossier).toMatchObject({ title: "Rental papers" });
    const listed = await (await listDossiers()).json();
    expect(listed.dossiers).toContainEqual(expect.objectContaining({ id: dossier.id, documentCount: 1 }));
  });

  it("rejects a document from another workspace with 422 and creates nothing", async () => {
    const foreignId = await addDocument(b.workspaceId, b.userId, "Not yours");
    const res = await createDossier({ name: "Nope", documentIds: [foreignId] });
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ code: "documents_not_found" });
    const rows = await holder.db!.select().from(dossiers).where(eq(dossiers.workspaceId, a.workspaceId));
    expect(rows.map((r) => r.title)).not.toContain("Nope");
  });

  it("a malformed body is a 422 problem", async () => {
    const res = await createDossier({ documentIds: [] });
    expect(res.status).toBe(422);
    expect(res.headers.get("content-type")).toContain("application/problem+json");
  });

  it("generate starts a run bound to the dossier", async () => {
    const created = await (await createDossier({ name: "Studio source", documentIds: [] })).json();
    const res = await generate(created.dossier.id, { brief: "Summarise the key dates" });
    expect(res.status).toBe(201);
    const { runId } = await res.json();
    const [run] = await holder.db!.select().from(agentRuns).where(eq(agentRuns.id, runId));
    expect(run.objective).toContain('dossier "Studio source"');
    expect(eveCalls[0].url).toBe("http://eve.fixture/eve/v1/session");
  });

  it("generate on an unknown dossier is a 404 problem; a foreign dossier is not found either", async () => {
    const created = await (await createDossier({ name: "Private", documentIds: [] })).json();
    holder.auth = { ...b, role: "owner" };
    const foreign = await generate(created.dossier.id, { brief: "x" });
    expect(foreign.status).toBe(404);
    holder.auth = { ...a, role: "owner" };
    expect((await generate(crypto.randomUUID(), { brief: "x" })).status).toBe(404);
    expect((await generate("not-a-uuid", { brief: "x" })).status).toBe(404);
    expect((await generate(created.dossier.id, {})).status).toBe(422);
  });

  it("generate without a bridge secret is a 503 problem and starts nothing", async () => {
    vi.stubEnv("EVE_BRIDGE_SECRET", "");
    const created = await (await createDossier({ name: "No bridge", documentIds: [] })).json();
    const res = await generate(created.dossier.id, { brief: "x" });
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ code: "agent_bridge_unavailable" });
    expect(eveCalls).toHaveLength(0);
  });
});
