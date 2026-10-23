import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { makeTestDb, seedWorkspace } from "../helpers/test-workspace";

const handle = makeTestDb();
const suite = handle ? describe : describe.skip;
const holder: {
  db: ReturnType<typeof import("drizzle-orm/postgres-js").drizzle> | undefined;
  auth: { userId: string; workspaceId: string; role: "owner" } | undefined;
} = { db: undefined, auth: undefined };

vi.mock("@/lib/db", () => ({ get db() { return holder.db; } }));
vi.mock("@/lib/db-transaction", () => ({
  get withTransaction() {
    return (fn: Parameters<typeof import("@/lib/db-transaction").withTransaction>[0]) =>
      (holder.db!.transaction as typeof import("@/lib/db-transaction").withTransaction)(fn);
  },
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), updateTag: vi.fn() }));
vi.mock("@/lib/auth", () => ({
  getAuthContext: vi.fn(async () => {
    if (!holder.auth) throw new Error("no auth seeded");
    return holder.auth;
  }),
}));

/*
 * The focus action layer's negatives, against real Postgres. The actions are
 * server-only ("use server"), but they are plain async functions to vitest —
 * the seam is the same one the notebook add-source actions test. Every input
 * is `unknown` at this boundary, so the shape and the guard both get exercised:
 * a malformed version and a subject-less start are user-safe errors, never
 * thrown 500s, and nothing is written on a rejected call.
 */

import { startSessionAction, pauseSessionAction } from "@/app/(workspace)/neuralflow/work/actions";
import { focusSessions } from "@/domains/focus/schema";

beforeAll(async () => {
  if (!handle) return;
  holder.db = handle.db;
  const seed = await seedWorkspace(handle.db, `focus-actions-${Date.now()}`);
  holder.auth = { ...seed, role: "owner" };
});

afterAll(async () => { await handle?.client.end(); });

suite("focus session action negatives (real Postgres)", () => {
  /** The scratch database is shared across suites; count only this workspace's rows. */
  const workspaceRows = async () =>
    holder.db!.select().from(focusSessions).where(eq(focusSessions.workspaceId, holder.auth!.workspaceId));

  it("refuses to start without a subject or task, and writes nothing", async () => {
    if (!handle) return;
    const out = await startSessionAction({ subject: "   ", plannedMinutes: 25 });
    expect(out).toEqual({ ok: false, error: "Name what you are focusing on." });
    expect(await workspaceRows()).toHaveLength(0);
  });

  it("refuses a malformed transition input (version below 1, bad id)", async () => {
    if (!handle) return;
    expect(await pauseSessionAction({ sessionId: "not-a-uuid", expectedVersion: 1 })).toEqual({
      ok: false,
      error: "Reload and try again.",
    });
    expect(await pauseSessionAction({ sessionId: crypto.randomUUID(), expectedVersion: 0 })).toEqual({
      ok: false,
      error: "Reload and try again.",
    });
    expect(await workspaceRows()).toHaveLength(0);
  });

  it("a well-formed start succeeds and a stale-version pause names the reload", async () => {
    if (!handle) return;
    const started = await startSessionAction({ subject: "Write the report", plannedMinutes: 25 });
    expect(started).toEqual({ ok: true });
    const [row] = await workspaceRows();
    expect(row.state).toBe("running");
    const stale = await pauseSessionAction({ sessionId: row.id, expectedVersion: 9 });
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.error).toContain("changed since you loaded it");
  });
});
