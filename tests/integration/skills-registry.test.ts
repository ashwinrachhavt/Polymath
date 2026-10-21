import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { auditEvents } from "@/domains/audit/schema";
import { skills as skillsTable } from "@/domains/skills/schema";
import type { InspectedSkill } from "@/domains/skills/manifest";
import { makeTestDb, ownerAuth, seedWorkspace } from "../helpers/test-workspace";

/*
 * ASH-200: the skills registry against a real workspace. Identity is
 * (workspace, source_kind, source_ref, source_path), so a double submit lands
 * on one row, a second package in the same repo is a second row, and the same
 * package may exist in two workspaces without either seeing the other.
 */

const handle = makeTestDb();
const suite = handle ? describe : describe.skip;
let db: NonNullable<typeof handle>["db"];
let commands: typeof import("@/domains/skills/commands");
let queries: typeof import("@/domains/skills/queries");

beforeAll(async () => {
  if (!handle) return;
  ({ db } = handle);
  commands = await import("@/domains/skills/commands");
  queries = await import("@/domains/skills/queries");
});

afterAll(async () => {
  await handle?.client.end();
});

function inspected(name: string, path: string): InspectedSkill & { revision: string } {
  return {
    name,
    slug: name.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
    description: `${name} procedure`,
    body: `# ${name}\n\nDo the thing.`,
    files: [{ path: "SKILL.md", text: `# ${name}` }],
    warnings: [],
    contentHash: `hash-${path}`,
    revision: `rev-${path}`,
  };
}

suite("skills registry", () => {
  it("installs one row per identity and returns the existing row on a second submit", async () => {
    const seeded = await seedWorkspace(db, `skills-${Date.now()}`);
    const auth = ownerAuth(seeded.userId, seeded.workspaceId);
    const input = {
      ...inspected("Release notes", "packages/release-notes"),
      sourceKind: "github" as const,
      sourceRef: "acme/skills",
      sourcePath: "packages/release-notes",
    };

    const first = await commands.installSkill(auth, input);
    expect(first.created).toBe(true);

    const second = await commands.installSkill(auth, input);
    expect(second).toEqual({ skillId: first.skillId, created: false });

    const rows = await db
      .select()
      .from(skillsTable)
      .where(eq(skillsTable.workspaceId, auth.workspaceId));
    expect(rows).toHaveLength(1);

    // The install is audited once; the losing double submit does not add a row.
    const audits = await db
      .select()
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.workspaceId, auth.workspaceId),
          eq(auditEvents.subjectId, first.skillId),
          eq(auditEvents.action, "skill.installed"),
        ),
      );
    expect(audits).toHaveLength(1);
  });

  it("installs a second row when the source path differs", async () => {
    const seeded = await seedWorkspace(db, `skills2-${Date.now()}`);
    const auth = ownerAuth(seeded.userId, seeded.workspaceId);
    const base = { sourceKind: "github" as const, sourceRef: "acme/monorepo" };

    const a = await commands.installSkill(auth, {
      ...inspected("Alpha", "packages/alpha"),
      sourcePath: "packages/alpha",
      ...base,
    });
    const b = await commands.installSkill(auth, {
      ...inspected("Beta", "packages/beta"),
      sourcePath: "packages/beta",
      ...base,
    });

    expect(a.created).toBe(true);
    expect(b.created).toBe(true);
    expect(a.skillId).not.toBe(b.skillId);

    const rows = await db
      .select()
      .from(skillsTable)
      .where(eq(skillsTable.workspaceId, auth.workspaceId));
    expect(rows).toHaveLength(2);
  });

  it("lets two workspaces hold the same identity", async () => {
    const a = await seedWorkspace(db, `skillsA-${Date.now()}`);
    const b = await seedWorkspace(db, `skillsB-${Date.now()}`);
    const input = {
      ...inspected("Shared", "packages/shared"),
      sourceKind: "github" as const,
      sourceRef: "acme/skills",
      sourcePath: "packages/shared",
    };

    const installedA = await commands.installSkill(ownerAuth(a.userId, a.workspaceId), input);
    const installedB = await commands.installSkill(ownerAuth(b.userId, b.workspaceId), input);
    expect(installedA.created).toBe(true);
    expect(installedB.created).toBe(true);
    expect(installedA.skillId).not.toBe(installedB.skillId);

    // Each workspace reads only its own row, and a foreign id is not found.
    const listA = await queries.listSkills({ workspaceId: a.workspaceId });
    expect(listA.map((s) => s.id)).toEqual([installedA.skillId]);
    expect(await queries.getSkill({ workspaceId: b.workspaceId }, installedA.skillId)).toBeNull();
  });

  it("tombstones the row and writes a skill.removed audit row", async () => {
    const seeded = await seedWorkspace(db, `skills3-${Date.now()}`);
    const auth = ownerAuth(seeded.userId, seeded.workspaceId);
    const installed = await commands.installSkill(auth, {
      ...inspected("Removable", "packages/removable"),
      sourceKind: "local" as const,
      sourceRef: "/tmp/skills",
      sourcePath: "packages/removable",
    });

    const removed = await commands.removeSkill(auth, { id: installed.skillId });
    expect(removed).toEqual({ removed: true });

    // The row is archived, not deleted: an in-flight pinned run keeps its
    // procedure, while every list hides the tombstone.
    const [row] = await db.select().from(skillsTable).where(eq(skillsTable.id, installed.skillId));
    expect(row?.archivedAt).not.toBeNull();
    expect(await queries.listSkills({ workspaceId: auth.workspaceId })).toHaveLength(0);
    expect(await queries.getSkill({ workspaceId: auth.workspaceId }, installed.skillId)).toBeNull();
    const audits = await db
      .select()
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.workspaceId, auth.workspaceId),
          eq(auditEvents.subjectId, installed.skillId),
          eq(auditEvents.action, "skill.removed"),
        ),
      );
    expect(audits).toHaveLength(1);

    // Removing a tombstone is a no-op success: the row is already gone from
    // every view, and no second audit row is invented.
    expect(await commands.removeSkill(auth, { id: installed.skillId })).toEqual({ removed: true });
    expect(audits).toHaveLength(1);
  });

  it("refuses a re-install when the source moved to a new revision", async () => {
    const seeded = await seedWorkspace(db, `skills5-${Date.now()}`);
    const auth = ownerAuth(seeded.userId, seeded.workspaceId);
    const first = await commands.installSkill(auth, {
      ...inspected("Movable", "packages/movable"),
      sourceKind: "github" as const,
      sourceRef: "owner/repo",
      sourcePath: "packages/movable",
      revision: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    });
    expect(first.created).toBe(true);

    await expect(
      commands.installSkill(auth, {
        ...inspected("Movable", "packages/movable"),
        sourceKind: "github" as const,
        sourceRef: "owner/repo",
        sourcePath: "packages/movable",
        revision: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      }),
    ).rejects.toThrow(/different revision/);
    // The refusal leaves the original row as the only copy.
    const rows = await db
      .select({ revision: skillsTable.revision })
      .from(skillsTable)
      .where(eq(skillsTable.id, first.skillId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.revision).toBe("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  });

  it("filters disabled skills out of the enabled list", async () => {
    const seeded = await seedWorkspace(db, `skills4-${Date.now()}`);
    const auth = ownerAuth(seeded.userId, seeded.workspaceId);
    const keep = await commands.installSkill(auth, {
      ...inspected("Keep", "packages/keep"),
      sourceKind: "bundled" as const,
      sourceRef: "bundled",
      sourcePath: "packages/keep",
    });
    const drop = await commands.installSkill(auth, {
      ...inspected("Drop", "packages/drop"),
      sourceKind: "bundled" as const,
      sourceRef: "bundled",
      sourcePath: "packages/drop",
    });

    expect(await commands.setSkillEnabled(auth, { id: drop.skillId, enabled: false })).toEqual({
      updated: true,
    });

    const enabled = await queries.listSkills({ workspaceId: auth.workspaceId }, { enabled: true });
    expect(enabled.map((s) => s.id)).toEqual([keep.skillId]);

    const disabled = await queries.listSkills({ workspaceId: auth.workspaceId }, { enabled: false });
    expect(disabled.map((s) => s.id)).toEqual([drop.skillId]);

    // The disable/enable write is audited with the action matching the new state.
    const disableAudits = await db
      .select()
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.workspaceId, auth.workspaceId),
          eq(auditEvents.subjectId, drop.skillId),
          eq(auditEvents.action, "skill.disabled"),
        ),
      );
    expect(disableAudits).toHaveLength(1);

    // An unknown id is a no-op, not a write to another workspace.
    expect(await commands.setSkillEnabled(auth, { id: keep.skillId, enabled: false })).toEqual({
      updated: true,
    });
    const keepDisables = await db
      .select()
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.workspaceId, auth.workspaceId),
          eq(auditEvents.subjectId, keep.skillId),
          eq(auditEvents.action, "skill.disabled"),
        ),
      );
    expect(keepDisables).toHaveLength(1);

    expect(
      await commands.setSkillEnabled(auth, { id: crypto.randomUUID(), enabled: false }),
    ).toEqual({ updated: false });
    const allAudits = await db
      .select()
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.workspaceId, auth.workspaceId),
          eq(auditEvents.action, "skill.disabled"),
        ),
      );
    expect(allAudits).toHaveLength(2);
  });

  it("returns null from loadPinnedSkill for an id in another workspace", async () => {
    const a = await seedWorkspace(db, `skillsC-${Date.now()}`);
    const b = await seedWorkspace(db, `skillsD-${Date.now()}`);
    const installed = await commands.installSkill(ownerAuth(a.userId, a.workspaceId), {
      ...inspected("Pinned", "packages/pinned"),
      sourceKind: "github" as const,
      sourceRef: "acme/skills",
      sourcePath: "packages/pinned",
    });

    const own = await queries.loadPinnedSkill(a.workspaceId, installed.skillId);
    expect(own).toMatchObject({ description: "Pinned procedure" });
    expect(own?.files).toEqual([{ path: "SKILL.md", text: "# Pinned" }]);

    expect(await queries.loadPinnedSkill(b.workspaceId, installed.skillId)).toBeNull();
  });
});
