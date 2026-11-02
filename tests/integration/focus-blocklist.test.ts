import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { apiClients, workspaces } from "@/domains/identity/schema";
import { makeTestDb, seedWorkspace } from "../helpers/test-workspace";

/*
 * The blocklist route's auth contract, at the layer production runs: the real
 * handlers against the scratch database, with only Clerk and the db transports
 * swapped (same shape as captures-route.test.ts).
 *
 * The machine story is read-only by design: a key scoped `focus:read` reads
 * the blocklist the extension enforces, while every write resolves only for
 * signed-in humans — focus:write is deliberately absent from API_KEY_SCOPES,
 * so no key can ever carry it. The response's array order is the precedence
 * contract: allows before blocks, each kind alphabetical by pattern.
 *
 * Skipped unless TEST_DATABASE_URL points at a database with the migrations
 * applied; required in CI.
 */

const handle = makeTestDb();
const suite = handle ? describe : describe.skip;

const holder: {
  db: ReturnType<typeof drizzle> | undefined;
  auth: { userId: string; workspaceId: string; role: "owner" } | undefined;
} = {
  db: undefined,
  auth: undefined,
};

vi.mock("@/lib/db", () => ({
  get db() {
    return holder.db;
  },
}));
// The route under test reads the Clerk session only on the human path; the
// bearer path resolves the machine key against the real test database.
const clerkState = vi.hoisted(() => ({ authResult: { isAuthenticated: false } as Record<string, unknown> }));
vi.mock("@/lib/clerk", () => ({ clerkConfigured: true, devAuthBypass: false }));
vi.mock("@clerk/nextjs/server", () => ({
  auth: vi.fn(async () => clerkState.authResult),
}));
vi.mock("@/domains/identity/resolve", () => ({
  resolveAuthContext: vi.fn(async () => holder.auth),
}));

import { GET, POST } from "@/app/api/v1/focus/blocklist/route";
import { PATCH, DELETE } from "@/app/api/v1/focus/blocklist/[blockId]/route";
import { GET as GET_LIVE } from "@/app/api/v1/focus/live/route";
import { mintApiClient } from "@/domains/identity/machine";

const BASE = "https://axiom.dev/api/v1/focus/blocklist";

function blocklistRequest(method: string, body?: unknown, token?: string, extraPath = "") {
  return new Request(`${BASE}${extraPath}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function machineKey(workspaceId: string, scopes: string[]): Promise<string> {
  const minted = await mintApiClient({
    workspaceId,
    name: `focus-blocklist-${scopes.join("-")}-${Date.now()}`,
    kind: "machine",
    scopes,
  });
  return minted.token;
}

const createdWorkspaceIds: string[] = [];

async function workspace(tag: string) {
  const seeded = await seedWorkspace(handle!.db, `blocklist-${tag}-${Date.now()}`);
  createdWorkspaceIds.push(seeded.workspaceId);
  return seeded;
}

beforeAll(async () => {
  if (!handle) return;
  holder.db = handle.db;
});

afterAll(async () => {
  for (const workspaceId of createdWorkspaceIds) {
    await handle!.db.delete(workspaces).where(eq(workspaces.id, workspaceId));
  }
  await handle?.client.end();
});

suite("blocklist route auth: 401, 403, and the scoped read", () => {
  it("answers 401 with no credential at all", async () => {
    const res = await GET(blocklistRequest("GET"), undefined);
    expect(res.status).toBe(401);
    expect(res.headers.get("content-type")).toContain("application/problem+json");
    const body = await res.json();
    expect(body.code).toBe("unauthorized");
  });

  it("answers 403 when a machine key lacks focus:read", async () => {
    const { workspaceId } = await workspace("no-scope");
    const token = await machineKey(workspaceId, ["captures:read"]);
    const res = await GET(blocklistRequest("GET", undefined, token), undefined);
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe("forbidden");
    expect(body.title).toContain("focus:read");
  });

  it("a focus:read machine key reads the blocklist, allows before blocks", async () => {
    const { userId, workspaceId } = await workspace("scoped-read");
    // Seeded deliberately out of contract order; the response must not care.
    const human = { userId, workspaceId, role: "owner" as const };
    await createVia(human, { pattern: "zebra.com", kind: "block" });
    await createVia(human, { pattern: "alpha.org", kind: "allow" });
    await createVia(human, { pattern: "middle.net", kind: "block" });
    await createVia(human, { pattern: "aardvark.dev", kind: "allow" });

    const token = await machineKey(workspaceId, ["focus:read"]);
    const res = await GET(blocklistRequest("GET", undefined, token), undefined);
    expect(res.status).toBe(200);
    const { entries } = await res.json();
    expect(entries.map((e: { kind: string; pattern: string }) => `${e.kind}:${e.pattern}`)).toEqual([
      "allow:aardvark.dev",
      "allow:alpha.org",
      "block:middle.net",
      "block:zebra.com",
    ]);
    // The entry ids round-trip: the client can act on what it read.
    expect(entries[0].id).toBeTruthy();
  });

  it("a machine key cannot write the blocklist — focus:write is ungrantable", async () => {
    const { workspaceId } = await workspace("machine-write");
    const token = await machineKey(workspaceId, ["focus:read", "captures:write"]);
    const res = await POST(blocklistRequest("POST", { pattern: "evil.example" }, token), undefined);
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.title).toContain("focus:write");
    const rows = await holder.db!.select().from(apiClients).where(eq(apiClients.workspaceId, workspaceId));
    expect(rows).toHaveLength(1); // the key itself was minted; nothing else changed
  });

  it("rejects a body with no pattern", async () => {
    const { userId, workspaceId } = await workspace("bad-body");
    holder.auth = { userId, workspaceId, role: "owner" };
    clerkState.authResult = { isAuthenticated: true, userId: "clerk_test" };
    const res = await POST(blocklistRequest("POST", {}), undefined);
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.code).toBe("invalid_input");
  });
});

suite("blocklist curation: the setup screen's CRUD", () => {
  it("creates lowercased and answers 409 with existingBlocklistId on a duplicate", async () => {
    const { userId, workspaceId } = await workspace("dedupe");
    holder.auth = { userId, workspaceId, role: "owner" };
    clerkState.authResult = { isAuthenticated: true, userId: "clerk_test" };

    const first = await POST(blocklistRequest("POST", { pattern: "GitHub.com" }), undefined);
    expect(first.status).toBe(201);
    const { entry } = await first.json();
    expect(entry.pattern).toBe("github.com");
    expect(entry.kind).toBe("block");

    const dupe = await POST(blocklistRequest("POST", { pattern: "github.com" }), undefined);
    expect(dupe.status).toBe(409);
    expect(dupe.headers.get("content-type")).toContain("application/problem+json");
    const body = await dupe.json();
    expect(body.code).toBe("conflict");
    expect(body.existingBlocklistId).toBe(entry.id);
  });

  it("PATCH flips the verdict, DELETE archives, and the pattern can be re-added", async () => {
    const { userId, workspaceId } = await workspace("lifecycle");
    holder.auth = { userId, workspaceId, role: "owner" };
    clerkState.authResult = { isAuthenticated: true, userId: "clerk_test" };

    const created = await POST(blocklistRequest("POST", { pattern: "news.ycombinator.com" }), undefined);
    const { entry } = await created.json();

    const patched = await PATCH(blocklistRequest("PATCH", { kind: "allow" }, undefined, `/${entry.id}`), {
      params: Promise.resolve({ blockId: entry.id }),
    });
    expect(patched.status).toBe(200);
    expect((await patched.json()).entry.kind).toBe("allow");

    const removed = await DELETE(blocklistRequest("DELETE", undefined, undefined, `/${entry.id}`), {
      params: Promise.resolve({ blockId: entry.id }),
    });
    expect(removed.status).toBe(200);
    expect((await removed.json()).entry.archivedAt).toBeTruthy();

    expect((await (await GET(blocklistRequest("GET"), undefined)).json()).entries).toEqual([]);

    const reAdded = await POST(blocklistRequest("POST", { pattern: "news.ycombinator.com", kind: "allow" }), undefined);
    expect(reAdded.status).toBe(201);
    expect((await reAdded.json()).entry.id).not.toBe(entry.id);
  });

  it("a foreign workspace sees no entries", async () => {
    const mine = await workspace("mine");
    const theirs = await workspace("theirs");
    holder.auth = { userId: theirs.userId, workspaceId: theirs.workspaceId, role: "owner" };
    clerkState.authResult = { isAuthenticated: true, userId: "clerk_test" };
    await POST(blocklistRequest("POST", { pattern: "their-private.example" }), undefined);
    holder.auth = { userId: mine.userId, workspaceId: mine.workspaceId, role: "owner" };
    expect((await (await GET(blocklistRequest("GET"), undefined)).json()).entries).toEqual([]);
  });
});

suite("GET /api/v1/focus/live now scopes machine keys", () => {
  it("403 without focus:read, 200 with it", async () => {
    const { workspaceId } = await workspace("live-scope");
    const denied = await machineKey(workspaceId, ["captures:read"]);
    const deniedRes = await GET_LIVE(blocklistRequest("GET", undefined, denied), undefined);
    expect(deniedRes.status).toBe(403);

    const allowed = await machineKey(workspaceId, ["focus:read"]);
    const allowedRes = await GET_LIVE(blocklistRequest("GET", undefined, allowed), undefined);
    expect(allowedRes.status).toBe(200);
    const body = await allowedRes.json();
    expect(body).toEqual({ session: null });
  });
});

/** POST through the route as a given auth context — the seeding helper for the read-order test. */
async function createVia(
  auth: { userId: string; workspaceId: string; role: "owner" },
  body: { pattern: string; kind?: "block" | "allow" },
) {
  holder.auth = auth;
  clerkState.authResult = { isAuthenticated: true, userId: "clerk_test" };
  const res = await POST(blocklistRequest("POST", body), undefined);
  expect(res.status).toBe(201);
  return (await res.json()).entry;
}
