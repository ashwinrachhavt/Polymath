import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { areas } from "@/domains/knowledge/schema";
import { makeTestDb, ownerAuth, seedWorkspace } from "../helpers/test-workspace";

/*
 * The area search consumer's resolution boundary (Product Spec, "Areas and
 * progress" + the search area dimension): a requested area resolves only
 * inside the caller's own workspace, and "unavailable" never degrades to an
 * unfiltered search - nonexistent, archived, another tenant's, or no usable
 * tags all produce the one generic state.
 */

const handle = makeTestDb();
const suite = handle ? describe : describe.skip;
const holder: { db: ReturnType<typeof drizzle> | undefined } = { db: undefined };
vi.mock("@/lib/db", () => ({ get db() { return holder.db; } }));

import { listSearchAreaNames, resolveSearchArea } from "@/domains/knowledge/area-resolve";

beforeAll(() => { holder.db = handle?.db; });
afterAll(async () => { await handle?.client.end(); });

async function workspaceWithAreas(tags: Record<string, string[]>) {
  const { userId, workspaceId } = await seedWorkspace(holder.db!, `ar-${crypto.randomUUID()}`);
  for (const [name, t] of Object.entries(tags)) {
    await holder.db!.insert(areas).values({ workspaceId, name, tags: t });
  }
  return ownerAuth(userId, workspaceId);
}

suite("search area resolution (real Postgres)", () => {
  it("resolves an own-workspace area case-insensitively, tags normalized like the predicate", async () => {
    const auth = await workspaceWithAreas({ Training: ["Health", " training-log ", "health"] });
    const r = await resolveSearchArea(auth, "  training ");
    expect(r).toEqual({ status: "resolved", name: "Training", tags: ["health", "training-log"] });
  });

  it("another tenant's area name is unavailable - no cross-workspace resolution or disclosure", async () => {
    const auth = await workspaceWithAreas({ Finance: ["receipts"] });
    const other = await workspaceWithAreas({ Finance: ["invoices"] });
    void other;
    expect(await resolveSearchArea(auth, "Finance")).toEqual({ status: "resolved", name: "Finance", tags: ["receipts"] });
    // And a name that exists ONLY in the other workspace does not resolve here.
    const third = await workspaceWithAreas({ Secret: ["s"] });
    expect(await resolveSearchArea(auth, "Secret")).toEqual({ status: "unavailable" });
    expect((await resolveSearchArea(third, "Secret")).status).toBe("resolved");
  });

  it("archived areas do not resolve and leave the name free for a live one", async () => {
    const auth = await workspaceWithAreas({ Old: ["x"] });
    await holder.db!.update(areas).set({ archivedAt: new Date() }).where(eq(areas.name, "Old"));
    expect(await resolveSearchArea(auth, "Old")).toEqual({ status: "unavailable" });
    expect(await listSearchAreaNames(auth)).toEqual([]);
  });

  it("an area whose tags normalize to nothing is unavailable, never a broadened search", async () => {
    const auth = await workspaceWithAreas({ Empty: [" ", ""], Blank: [] });
    expect(await resolveSearchArea(auth, "Empty")).toEqual({ status: "unavailable" });
    expect(await resolveSearchArea(auth, "Blank")).toEqual({ status: "unavailable" });
  });

  it("blank or nonexistent names are the same generic unavailable", async () => {
    const auth = await workspaceWithAreas({ Training: ["health"] });
    expect(await resolveSearchArea(auth, "   ")).toEqual({ status: "unavailable" });
    expect(await resolveSearchArea(auth, "nope")).toEqual({ status: "unavailable" });
  });

  it("the filter control lists live own-workspace areas alphabetically, none from other tenants", async () => {
    const auth = await workspaceWithAreas({ Zeta: ["z"], Alpha: ["a"], Mid: ["m"] });
    await workspaceWithAreas({ Beta: ["b"] });
    expect(await listSearchAreaNames(auth)).toEqual(["Alpha", "Mid", "Zeta"]);
  });
});
