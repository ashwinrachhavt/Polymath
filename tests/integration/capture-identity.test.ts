import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { workspaces } from "@/domains/identity/schema";
import { captures } from "@/domains/capture/schema";
import { makeTestDb, ownerAuth, seedWorkspace } from "../helpers/test-workspace";
import type { AuthContext } from "@/domains/identity/resolve";

/*
 * Identity is mode-aware: two different selections from one article are two
 * captures, the same selection twice is one capture. Each test owns a fresh
 * workspace so the row counts below describe only that test's captures.
 */

const handle = makeTestDb();
const suite = handle ? describe : describe.skip;
let db: NonNullable<typeof handle>["db"];
let commands: typeof import("@/domains/capture/commands");
let auth: AuthContext;
let workspaceId: string;
const seededWorkspaces: string[] = [];

beforeAll(async () => {
  if (!handle) return;
  ({ db } = handle);
  commands = await import("@/domains/capture/commands");
});

beforeEach(async () => {
  if (!handle) return;
  const seeded = await seedWorkspace(db, `capture-identity-${Date.now()}-${seededWorkspaces.length}`);
  workspaceId = seeded.workspaceId;
  seededWorkspaces.push(seeded.workspaceId);
  auth = ownerAuth(seeded.userId, workspaceId);
});

afterAll(async () => {
  for (const id of seededWorkspaces) await db.delete(workspaces).where(eq(workspaces.id, id));
  await handle?.client.end();
});

suite("capture identity", () => {
  it("keeps two different selections from one article", async () => {
    const url = "https://example.com/article";
    await commands.createCapture(auth, { text: "first selection", url, mode: "selection" });
    await commands.createCapture(auth, { text: "second selection", url, mode: "selection" });
    const rows = await db.select().from(captures).where(eq(captures.workspaceId, workspaceId));
    expect(rows).toHaveLength(2);
  });

  it("rejects the identical selection twice with the existing id", async () => {
    const url = "https://example.com/article-2";
    const first = await commands.createCapture(auth, { text: "same words", url, mode: "selection" });
    await expect(commands.createCapture(auth, { text: "same words", url, mode: "selection" }))
      .rejects.toMatchObject({ code: "conflict", existingId: first.id });
    const rows = await db.select().from(captures).where(eq(captures.workspaceId, workspaceId));
    expect(rows).toHaveLength(1);
  });
});
