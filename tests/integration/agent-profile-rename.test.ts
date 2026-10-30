import { readFileSync } from "node:fs";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { auditEvents } from "@/domains/audit/schema";
import { agentProfiles } from "@/domains/agents/schema";
import { makeTestDb, seedWorkspace } from "../helpers/test-workspace";

/*
 * Migration 0260 renames the "alfred" agent profile to "polymath", recording
 * lineage in metadata.renamedFrom. A workspace where a person already chose
 * the name "polymath" collides on the unique (workspace, name) index: the
 * alfred profile must become "polymath-2" (audit-evented), never fail the
 * deploy, and a user-chosen name must never be rewritten. The test executes
 * the real migration file against seeded rows, then checks the
 * ensureProfile resolution order (exact name, then lineage) on the
 * collision path.
 *
 * Value: protects=the rename is scoped, collision-safe and lineage-resolved;
 * fails_when=the migration rewrites a user-chosen name, fails on a collision,
 * or ensureProfile creates a second profile after a collision rename.
 */

const handle = makeTestDb();
const suite = handle ? describe : describe.skip;

const MIGRATION = readFileSync(
  join(process.cwd(), "src/db/migrations/0260_agent_profile_polymath_rename.sql"),
  "utf8",
);

async function applyMigration(client: NonNullable<typeof handle>["client"]) {
  for (const stmt of MIGRATION.split("--> statement-breakpoint")) {
    const sql = stmt.trim();
    if (sql) await client.unsafe(sql);
  }
}

async function seedProfile(workspaceId: string, name: string) {
  const [row] = await handle!.db.insert(agentProfiles).values({ workspaceId, name }).returning();
  return row;
}

suite("agent profile rename migration", () => {
  let plainWs: string;
  let collisionWs: string;

  beforeAll(async () => {
    if (!handle) return;
    plainWs = (await seedWorkspace(handle.db, `rename-plain-${Date.now()}`)).workspaceId;
    collisionWs = (await seedWorkspace(handle.db, `rename-collision-${Date.now()}`)).workspaceId;
    await seedProfile(plainWs, "alfred");
    await seedProfile(collisionWs, "polymath"); // user-chosen name
    await seedProfile(collisionWs, "alfred");
    await applyMigration(handle.client);
  });

  afterAll(async () => {
    await handle?.client.end();
  });

  it("renames alfred to polymath with lineage, leaving user-chosen names alone", async () => {
    const plain = await handle!.db.select().from(agentProfiles).where(eq(agentProfiles.workspaceId, plainWs));
    expect(plain).toHaveLength(1);
    expect(plain[0].name).toBe("polymath");
    expect((plain[0].metadata as Record<string, unknown>).renamedFrom).toBe("alfred");

    const collided = await handle!.db
      .select()
      .from(agentProfiles)
      .where(eq(agentProfiles.workspaceId, collisionWs));
    const byName = Object.fromEntries(collided.map((p) => [p.name, p]));
    expect(byName["polymath"]).toBeDefined();
    expect((byName["polymath"].metadata as Record<string, unknown>)?.renamedFrom).toBeUndefined();
    expect(byName["polymath-2"]).toBeDefined();
    expect((byName["polymath-2"].metadata as Record<string, unknown>).renamedFrom).toBe("alfred");
  });

  it("audit-events the collision rename", async () => {
    const rows = await handle!.db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.workspaceId, collisionWs), eq(auditEvents.action, "agent_profile.rename_collision")));
    expect(rows).toHaveLength(1);
    expect(rows[0].summary).toContain("polymath-2");
  });

  it("ensureProfile binds the lineage profile over a user-chosen name on the collision path", async () => {
    const { ensureProfile } = await import("@/domains/agents/commands");
    const before = await handle!.db.select().from(agentProfiles).where(eq(agentProfiles.workspaceId, collisionWs));
    const id = await ensureProfile(collisionWs, "polymath");
    const after = await handle!.db.select().from(agentProfiles).where(eq(agentProfiles.workspaceId, collisionWs));
    expect(after).toHaveLength(before.length);
    // Lineage first (plan §16.3): the renamed alfred profile ("polymath-2")
    // is the chief-of-staff profile, not the user-chosen "polymath" row.
    const lineage = after.find((p) => (p.metadata as Record<string, unknown>).renamedFrom === "alfred");
    expect(lineage).toBeDefined();
    expect(id).toBe(lineage!.id);

    const lineageId = await ensureProfile(plainWs, "polymath");
    const plain = await handle!.db.select().from(agentProfiles).where(eq(agentProfiles.workspaceId, plainWs));
    expect(plain[0].id).toBe(lineageId);
  });

  it("resolves polymath-lineage by metadata when no exact name matches", async () => {
    // Simulates a post-collision workspace whose user-chosen "polymath" row
    // was later retired: the renamedFrom lineage must still win over insert.
    const ws = (await seedWorkspace(handle!.db, `rename-lineage-${Date.now()}`)).workspaceId;
    await handle!.db.insert(agentProfiles).values({
      workspaceId: ws,
      name: "polymath-2",
      metadata: { renamedFrom: "alfred" },
    });
    const { ensureProfile } = await import("@/domains/agents/commands");
    const id = await ensureProfile(ws, "polymath");
    const rows = await handle!.db.select().from(agentProfiles).where(eq(agentProfiles.workspaceId, ws));
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(id);
  });
});
