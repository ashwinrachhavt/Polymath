import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { captures } from "@/domains/capture/schema";
import { makeTestDb, seedWorkspace } from "../helpers/test-workspace";

/*
 * The duplicate-URL contract the browser companion switches on: POST
 * /api/v1/captures answers a repeated URL-only capture with 409
 * application/problem+json whose type/code/title/status members stay
 * byte-exact, plus the additive existingCaptureId pointing at the row that
 * is already there. The route runs for real against the scratch database;
 * only Clerk and the db transports are swapped, same as file-intake.test.ts.
 *
 * Skipped unless TEST_DATABASE_URL points at a database with the migrations
 * applied. Fresh unique slugs, no truncation, following the other suites.
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
    return (fn: Parameters<
      typeof import("@/lib/db-transaction").withTransaction
    >[0]) =>
      (holder.db!.transaction as typeof import("@/lib/db-transaction").withTransaction)(fn);
  },
}));
vi.mock("@/lib/clerk", () => ({ clerkConfigured: true, devAuthBypass: false }));
vi.mock("@clerk/nextjs/server", () => ({
  auth: vi.fn(async () => ({ isAuthenticated: true, userId: "clerk_test" })),
}));
vi.mock("@/domains/identity/resolve", () => ({
  resolveAuthContext: vi.fn(async () => holder.auth),
}));

import { POST } from "@/app/api/v1/captures/route";

function captureRequest(body: unknown) {
  return new Request("https://axiom.dev/api/v1/captures", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("problemResponse extra members", () => {
  it("additive members can never override the pinned four", async () => {
    const { problemResponse } = await import("@/lib/problems");
    const res = problemResponse(409, "conflict", "That URL is already in the inbox.", {
      existingCaptureId: "capt-1",
      code: "sneaky",
      title: "sneaky",
      type: "sneaky",
      status: 200,
    });
    const body = await res.json();
    expect(body.existingCaptureId).toBe("capt-1");
    expect(body.code).toBe("conflict");
    expect(body.title).toBe("That URL is already in the inbox.");
    expect(body.type).toBe("https://axiom.dev/problems/conflict");
    expect(body.status).toBe(409);
    expect(res.headers.get("content-type")).toContain("application/problem+json");
  });
});

suite("POST /api/v1/captures duplicate contract", () => {
  beforeAll(async () => {
    if (!handle) return;
    holder.db = handle.db;
  });
  afterAll(async () => {
    await handle?.client.end();
  });

  it("409 keeps the pinned four members byte-exact and adds existingCaptureId", async () => {
    const { userId, workspaceId } = await seedWorkspace(handle!.db, `capture-route-${Date.now()}`);
    holder.auth = { userId, workspaceId, role: "owner" };
    const url = "https://example.com/companion-contract";

    const first = await POST(captureRequest({ url }), undefined);
    expect(first.status).toBe(201);
    const { capture } = await first.json();

    const dupe = await POST(captureRequest({ url }), undefined);
    expect(dupe.status).toBe(409);
    expect(dupe.headers.get("content-type")).toContain("application/problem+json");
    const body = await dupe.json();
    // The companion recognizes exactly these four members; they must not drift.
    expect(body.type).toBe("https://axiom.dev/problems/conflict");
    expect(body.code).toBe("conflict");
    expect(body.title).toBe("That URL is already in the inbox.");
    expect(body.status).toBe(409);
    // Additive: the capture that is already in the inbox, for "open it" UX.
    expect(body.existingCaptureId).toBe(capture.id);
    expect(Object.keys(body).sort()).toEqual(["code", "existingCaptureId", "status", "title", "type"]);
  });

  it("a different URL in the same workspace still creates", async () => {
    const { userId, workspaceId } = await seedWorkspace(handle!.db, `capture-route-distinct-${Date.now()}`);
    holder.auth = { userId, workspaceId, role: "owner" };
    const res = await POST(captureRequest({ url: "https://example.com/something-new" }), undefined);
    expect(res.status).toBe(201);
    const rows = await holder.db!.select().from(captures).where(eq(captures.workspaceId, workspaceId));
    expect(rows).toHaveLength(1);
  });

  it("records an explicit selection mode", async () => {
    const { userId, workspaceId } = await seedWorkspace(handle!.db, `capture-route-selection-${Date.now()}`);
    holder.auth = { userId, workspaceId, role: "owner" };
    const res = await POST(captureRequest({ text: "fragment", url: "https://example.com/s", mode: "selection" }), undefined);
    expect(res.status).toBe(201);
    const capture = (await res.json()).capture;
    expect(capture.captureMode).toBe("selection");
  });

  it("treats an address-only body as a url reference", async () => {
    const { userId, workspaceId } = await seedWorkspace(handle!.db, `capture-route-bare-${Date.now()}`);
    holder.auth = { userId, workspaceId, role: "owner" };
    const res = await POST(captureRequest({ url: "https://example.com/bare" }), undefined);
    expect(res.status).toBe(201);
    expect((await res.json()).capture.kind).toBe("url");
  });

  it("still accepts a body with no mode from an older extension", async () => {
    const { userId, workspaceId } = await seedWorkspace(handle!.db, `capture-route-legacy-${Date.now()}`);
    holder.auth = { userId, workspaceId, role: "owner" };
    const res = await POST(captureRequest({ text: "legacy", url: "https://example.com/legacy" }), undefined);
    expect(res.status).toBe(201);
    expect((await res.json()).capture.captureMode).toBe("page");
  });
});
