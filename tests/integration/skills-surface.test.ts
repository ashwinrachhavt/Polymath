import { eq } from "drizzle-orm";
import type { drizzle } from "drizzle-orm/postgres-js";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { makeTestDb, ownerAuth, seedWorkspace } from "../helpers/test-workspace";

/*
 * Task 6 against a real workspace: the action layer is what the page calls,
 * so the three behaviours that matter are proven here rather than through the
 * domain commands it wraps.
 *
 *   - Inspect is stateless: it returns what a folder holds and writes nothing.
 *   - Install is idempotent on the identity index, re-reading the source it was
 *     inspected from, so a double submit lands on one row.
 *   - Remove deletes the skill row and leaves the run that pinned it readable,
 *     because provenance lives in the run's frozen policy snapshot.
 */

const handle = makeTestDb();
const suite = handle ? describe : describe.skip;
const holder: {
  db: ReturnType<typeof drizzle> | undefined;
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

import { agentRuns } from "@/domains/agents/schema";
import { skills as skillsTable } from "@/domains/skills/schema";
import { listSkills } from "@/domains/skills/queries";
import { createEngine, type SessionDriver } from "@/domains/agents/engine";
import { ensureProfile } from "@/domains/agents/commands";
import {
  inspectSkillAction,
  installSkillAction,
  removeSkillAction,
} from "@/app/(workspace)/polymath/skills/actions";

let db: NonNullable<typeof handle>["db"];

beforeAll(() => {
  if (!handle) return;
  ({ db } = handle);
  holder.db = db;
});

afterAll(async () => {
  await handle?.client.end();
});

/** A folder the local adapter is allowed to read, laid out like a real package. */
const localRoots: string[] = [];

async function writeSkill(directory: string, name: string): Promise<void> {
  await mkdir(directory, { recursive: true });
  await writeFile(
    path.join(directory, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${name} procedure.\n---\n\nFollow these steps.\n`,
  );
}

beforeEach(async () => {
  holder.auth = undefined;
});

afterEach(async () => {
  delete process.env.SKILLS_LOCAL_ROOT;
  await Promise.all(localRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function newWorkspace(label: string) {
  const seeded = await seedWorkspace(db, `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  holder.auth = ownerAuth(seeded.userId, seeded.workspaceId);
  return seeded;
}

async function skillRows(workspaceId: string) {
  return db.select().from(skillsTable).where(eq(skillsTable.workspaceId, workspaceId));
}

function stubDriver(): SessionDriver {
  return {
    async start() {},
    async signal() {},
    async cancel() {},
  };
}

suite("skills surface actions (integration)", () => {
  it("inspects a local folder and returns its packages without writing a row", async () => {
    const seeded = await newWorkspace("surface-inspect");
    const root = await mkdtemp(path.join(tmpdir(), "skills-surface-"));
    localRoots.push(root);
    process.env.SKILLS_LOCAL_ROOT = root;
    await writeSkill(path.join(root, "release-notes"), "release-notes");

    const result = await inspectSkillAction({ source: path.join(root, "release-notes") });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.sourceKind).toBe("local");
    expect(result.skills).toHaveLength(1);
    expect(result.skills[0].name).toBe("release-notes");
    expect(result.skills[0].sourcePath).toBe("release-notes");
    expect(result.revision).toMatch(/^[0-9a-f]{64}$/);

    // Inspection is a read: nothing is staged for the install that follows.
    expect(await skillRows(seeded.workspaceId)).toHaveLength(0);
  });

  it("installs one row for a double submit with the same input", async () => {
    const seeded = await newWorkspace("surface-install");
    const root = await mkdtemp(path.join(tmpdir(), "skills-surface-"));
    localRoots.push(root);
    process.env.SKILLS_LOCAL_ROOT = root;
    await writeSkill(path.join(root, "weekly-review"), "weekly-review");

    const inspected = await inspectSkillAction({ source: path.join(root, "weekly-review") });
    if (!inspected.ok) throw new Error(inspected.error);
    const input = {
      source: path.join(root, "weekly-review"),
      sourcePath: inspected.skills[0].sourcePath,
      revision: inspected.revision,
    };

    const first = await installSkillAction(input);
    const second = await installSkillAction(input);

    expect(first).toMatchObject({ ok: true, created: true });
    expect(second).toMatchObject({ ok: true, created: false });
    if (!first.ok || !second.ok) return;
    expect(second.skillId).toBe(first.skillId);

    const rows = await skillRows(seeded.workspaceId);
    expect(rows).toHaveLength(1);
    expect(rows[0].slug).toBe("weekly-review");
    expect(rows[0].revision).toBe(inspected.revision);
  });

  it("refuses an install whose source changed after inspection", async () => {
    await newWorkspace("surface-drift");
    const root = await mkdtemp(path.join(tmpdir(), "skills-surface-"));
    localRoots.push(root);
    process.env.SKILLS_LOCAL_ROOT = root;
    await writeSkill(path.join(root, "drifting"), "drifting");

    const inspected = await inspectSkillAction({ source: path.join(root, "drifting") });
    if (!inspected.ok) throw new Error(inspected.error);

    await writeFile(
      path.join(root, "drifting", "SKILL.md"),
      "---\nname: drifting\ndescription: Rewritten after inspection.\n---\n\nNew steps.\n",
    );

    const installed = await installSkillAction({
      source: path.join(root, "drifting"),
      sourcePath: inspected.skills[0].sourcePath,
      revision: inspected.revision,
    });

    expect(installed.ok).toBe(false);
    if (installed.ok) return;
    expect(installed.error).toMatch(/changed since you inspected it/);
  });

  it("removes the skill and leaves the run that pinned it readable", async () => {
    vi.stubEnv("EVE_BASE_URL", "http://eve.fixture");
    vi.stubEnv("EVE_BRIDGE_SECRET", "q".repeat(40));
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ sessionId: "wrun_remove" }, { status: 202 })));

    const seeded = await newWorkspace("surface-remove");
    const root = await mkdtemp(path.join(tmpdir(), "skills-surface-"));
    localRoots.push(root);
    process.env.SKILLS_LOCAL_ROOT = root;
    await writeSkill(path.join(root, "retiring"), "retiring");

    const inspected = await inspectSkillAction({ source: path.join(root, "retiring") });
    if (!inspected.ok) throw new Error(inspected.error);
    const installed = await installSkillAction({
      source: path.join(root, "retiring"),
      sourcePath: inspected.skills[0].sourcePath,
      revision: inspected.revision,
    });
    if (!installed.ok) throw new Error(installed.error);

    await ensureProfile(seeded.workspaceId);
    const engine = createEngine(stubDriver());
    const { runId } = await engine.start({
      auth: holder.auth!,
      profileName: "polymath",
      objective: "Run the retiring skill",
      subjects: [],
      estimateUsd: "0.0001",
      skillId: installed.skillId,
    });

    const removed = await removeSkillAction({ id: installed.skillId });
    expect(removed).toEqual({ ok: true });
    // Tombstoned, not deleted: the row stays so the pinned run below keeps
    // its procedure, and listSkills (archivedAt-filtered) hides it.
    const [tombstone] = await db
      .select()
      .from(skillsTable)
      .where(eq(skillsTable.id, installed.skillId));
    expect(tombstone?.archivedAt).not.toBeNull();
    expect(await listSkills({ workspaceId: seeded.workspaceId }, { enabled: true })).toHaveLength(0);

    // The run still exists and still names the revision it was given.
    const [run] = await db.select().from(agentRuns).where(eq(agentRuns.id, runId));
    expect(run).toBeDefined();
    expect(run.policySnapshot).toMatchObject({
      skill: { id: installed.skillId, revision: inspected.revision },
    });

    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });
});
