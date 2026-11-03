import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { auditEvents } from "@/domains/audit/schema";
import { memberships, users, workspaces } from "@/domains/identity/schema";

/*
 * Spec D3: the createWorkspace command. A created workspace is only a tenant
 * if all three legs exist - the workspace row, the creator's owner
 * membership, and the workspace.created audit event - so each is asserted
 * here. The slug contract gets its own cases: auto derives and suffixes,
 * hand-edited collides as authored copy.
 *
 * Same harness as auth-resolution.test.ts: @/lib/db (the Neon HTTP driver)
 * is mocked to the postgres-js client the assertions use, pointed at
 * TEST_DATABASE_URL before the domain is lazy-imported. Fresh unique rows
 * per run, nothing truncated, so it is repeatable against a warm database.
 */
const handle = (function () {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) return null;
  // src/lib/db-transaction.ts reads DATABASE_URL at module load; point it here
  // before anything lazy-imports that module.
  process.env.DATABASE_URL = url;
  const client = postgres(url, { max: 1 });
  return { url, client, db: drizzle(client) };
})();
const suite = handle ? describe : describe.skip;
let db = handle?.db as ReturnType<typeof drizzle>;
const holder: { db: ReturnType<typeof drizzle> | undefined } = { db: undefined };
vi.mock("@/lib/db", () => ({
  get db() {
    return holder.db;
  },
}));

let createWorkspace: typeof import("@/domains/identity/workspaces").createWorkspace;
let WorkspaceConflictError: typeof import("@/domains/identity/workspaces").WorkspaceConflictError;

beforeAll(async () => {
  if (!handle) return;
  holder.db = handle.db;
  db = handle.db;
  ({ createWorkspace, WorkspaceConflictError } = await import("@/domains/identity/workspaces"));
});
afterAll(async () => {
  await handle?.client.end();
});

async function seedCreator(tag: string) {
  const [user] = await db
    .insert(users)
    .values({ clerkUserId: `cw_${tag}` })
    .returning();
  return user;
}

suite("createWorkspace (spec D3)", () => {
  it("creates the workspace, the owner membership, and the audit event in one transaction", async () => {
    const tag = `own${Date.now().toString(36)}`;
    const user = await seedCreator(tag);
    const auth = { userId: user.id, workspaceId: crypto.randomUUID(), role: "owner" as const };

    const result = await createWorkspace(auth, { name: `Alpha Site ${tag}` });

    const [workspace] = await db.select().from(workspaces).where(eq(workspaces.id, result.workspaceId));
    expect(workspace.name).toBe(`Alpha Site ${tag}`);
    expect(workspace.slug).toBe(`alpha-site-${tag}`);
    expect(workspace.isPersonal).toBe(false);

    // The creator is the workspace's active owner.
    const [membership] = await db
      .select()
      .from(memberships)
      .where(and(eq(memberships.workspaceId, workspace.id), eq(memberships.userId, user.id)));
    expect(membership.role).toBe("owner");
    expect(membership.status).toBe("active");

    // The audit event lives in the workspace it created, not the caller's.
    const [audit] = await db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.workspaceId, workspace.id), eq(auditEvents.action, "workspace.created")));
    expect(audit.subjectId).toBe(workspace.id);
    expect(audit.actorId).toBe(user.id);
  });

  it("suffixes an auto slug when the name is already taken", async () => {
    const tag = `sfx${Date.now().toString(36)}`;
    const user = await seedCreator(tag);
    const auth = { userId: user.id, workspaceId: crypto.randomUUID(), role: "owner" as const };

    const first = await createWorkspace(auth, { name: `Beta Site ${tag}` });
    const second = await createWorkspace(auth, { name: `Beta Site ${tag}` });

    expect(first.slug).toBe(`beta-site-${tag}`);
    expect(second.slug).toBe(`beta-site-${tag}-2`);
    expect(second.workspaceId).not.toBe(first.workspaceId);
  });

  it("surfaces a hand-edited slug collision as authored copy and creates nothing", async () => {
    const tag = `cfl${Date.now().toString(36)}`;
    const user = await seedCreator(tag);
    const auth = { userId: user.id, workspaceId: crypto.randomUUID(), role: "owner" as const };
    await createWorkspace(auth, { name: `Gamma Site ${tag}` });
    const before = await db
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(eq(workspaces.name, `Delta ${tag}`));

    await expect(createWorkspace(auth, { name: `Delta ${tag}`, slug: `gamma-site-${tag}` })).rejects.toMatchObject({
      name: "WorkspaceConflictError",
      code: "workspace_slug_taken",
    });
    // Authored copy, not the generic fallback: the action forwards the message.
    await expect(createWorkspace(auth, { name: `Delta ${tag}`, slug: `gamma-site-${tag}` })).rejects.toThrow(
      "That address is taken. Pick another.",
    );
    expect(
      await db
        .select({ id: workspaces.id })
        .from(workspaces)
        .where(eq(workspaces.name, `Delta ${tag}`)),
    ).toEqual(before);
  });

  it("rejects an empty name and an unbuildable slug as workspace_input", async () => {
    const tag = `inp${Date.now().toString(36)}`;
    const user = await seedCreator(tag);
    const auth = { userId: user.id, workspaceId: crypto.randomUUID(), role: "owner" as const };

    await expect(createWorkspace(auth, { name: "   " })).rejects.toMatchObject({
      name: "WorkspaceConflictError",
      code: "workspace_input",
    });
    await expect(createWorkspace(auth, { name: `Epsilon ${tag}`, slug: "!!!" })).rejects.toMatchObject({
      name: "WorkspaceConflictError",
      code: "workspace_input",
    });
  });
});

/* The class is a stable contract for action-error.ts; pin its shape. */
suite("WorkspaceConflictError", () => {
  it("carries its name and code for the action-error allowlist", () => {
    const error = new WorkspaceConflictError("workspace_slug_taken", "That address is taken. Pick another.");
    expect(error.name).toBe("WorkspaceConflictError");
    expect(error.code).toBe("workspace_slug_taken");
  });
});
