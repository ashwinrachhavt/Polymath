import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { agentRuns } from "@/domains/agents/schema";
import { skills as skillsTable } from "@/domains/skills/schema";
import { makeTestDb, ownerAuth, seedWorkspace } from "../helpers/test-workspace";

/*
 * Task 4 against a real workspace: a run that names a skill freezes that
 * skill's id, revision and content hash into its policy snapshot, and every
 * later change — an edit to the skill, a disable, a removal — cannot reach it.
 * The pin is resolved before the run row exists, so an unusable skill starts
 * nothing at all.
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
  authedHandler: (handler: (auth: NonNullable<typeof holder.auth>, request: Request) => Promise<Response>) =>
    (request: Request) => handler(holder.auth!, request),
}));

import { POST } from "@/app/api/v1/runs/route";

let db: NonNullable<typeof handle>["db"];
let engineModule: typeof import("@/domains/agents/engine");
let commands: typeof import("@/domains/agents/commands");
let skillCommands: typeof import("@/domains/skills/commands");

beforeAll(async () => {
  if (!handle) return;
  ({ db } = handle);
  holder.db = db;
  engineModule = await import("@/domains/agents/engine");
  commands = await import("@/domains/agents/commands");
  skillCommands = await import("@/domains/skills/commands");
});

afterAll(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  await handle?.client.end();
});

let counter = 0;

/** A stub driver: the pin is decided before the session, so nothing real is started. */
function stubDriver() {
  return {
    start: async () => {},
    signal: async () => {},
    cancel: async () => {},
  };
}

async function installSkill(workspaceId: string, userId: string, label: string) {
  const slug = `${label}-${Date.now()}-${++counter}`;
  const { skillId } = await skillCommands.installSkill(ownerAuth(userId, workspaceId), {
    name: label,
    slug,
    description: `${label} procedure`,
    body: `# ${label}\n\nDo the thing.`,
    files: [{ path: "SKILL.md", text: `# ${label}` }],
    warnings: [],
    contentHash: `hash-${slug}`,
    revision: `rev-${slug}`,
    sourceKind: "bundled" as const,
    sourceRef: "bundled",
    sourcePath: `packages/${slug}`,
  });
  return skillId;
}

async function startRun(
  userId: string,
  workspaceId: string,
  skillId?: string,
): Promise<{ runId: string }> {
  await commands.ensureProfile(workspaceId);
  const engine = engineModule.createEngine(stubDriver());
  return engine.start({
    auth: ownerAuth(userId, workspaceId),
    profileName: "alfred",
    objective: "Use the pinned skill",
    subjects: [],
    estimateUsd: "0.0001",
    skillId,
  });
}

const countRuns = async (workspaceId: string) =>
  (await db.select({ id: agentRuns.id }).from(agentRuns).where(eq(agentRuns.workspaceId, workspaceId))).length;

async function runRow(runId: string) {
  const [run] = await db.select().from(agentRuns).where(eq(agentRuns.id, runId));
  if (!run) throw new Error("run not found");
  return run;
}

suite("skill run pinning", () => {
  beforeEach(() => {
    vi.stubEnv("EVE_BASE_URL", "http://eve.fixture");
    vi.stubEnv("EVE_BRIDGE_SECRET", "q".repeat(40));
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ sessionId: "wrun_pin" }, { status: 202 })));
  });

  it("freezes the skill's id, revision and content hash into the run's policy snapshot", async () => {
    const seeded = await seedWorkspace(db, `pin-a-${Date.now()}`);
    const skillId = await installSkill(seeded.workspaceId, seeded.userId, "Release notes");
    const [skill] = await db.select().from(skillsTable).where(eq(skillsTable.id, skillId));
    const { runId } = await startRun(seeded.userId, seeded.workspaceId, skillId);

    const run = await runRow(runId);
    expect(run.policySnapshot).toMatchObject({
      skill: { id: skillId, revision: skill.revision, contentHash: skill.contentHash, name: skill.name },
    });
  });

  it("leaves the stored pin alone after the skill's body is edited", async () => {
    const seeded = await seedWorkspace(db, `pin-b-${Date.now()}`);
    const skillId = await installSkill(seeded.workspaceId, seeded.userId, "Weekly review");
    const { runId } = await startRun(seeded.userId, seeded.workspaceId, skillId);
    const before = (await runRow(runId)).policySnapshot;

    await db
      .update(skillsTable)
      .set({ body: "# Weekly review\n\nRewritten.", revision: "rev-edited", contentHash: "hash-edited" })
      .where(eq(skillsTable.id, skillId));

    const after = (await runRow(runId)).policySnapshot;
    expect(after).toEqual(before);
    expect((after as { skill: { revision: string } }).skill.revision).not.toBe("rev-edited");
  });

  it("refuses a disabled skill and creates no run row", async () => {
    const seeded = await seedWorkspace(db, `pin-c-${Date.now()}`);
    const auth = ownerAuth(seeded.userId, seeded.workspaceId);
    const skillId = await installSkill(seeded.workspaceId, seeded.userId, "Paused");
    await skillCommands.setSkillEnabled(auth, { id: skillId, enabled: false });
    await commands.ensureProfile(seeded.workspaceId);
    const before = await countRuns(seeded.workspaceId);

    await expect(startRun(seeded.userId, seeded.workspaceId, skillId)).rejects.toThrow(
      "That skill is not available. Enable it in Skills and try again.",
    );

    const after = await countRuns(seeded.workspaceId);
    expect(after).toBe(before);
  });

  it("refuses a skill from another workspace and creates no run row", async () => {
    const a = await seedWorkspace(db, `pin-d-a-${Date.now()}`);
    const b = await seedWorkspace(db, `pin-d-b-${Date.now()}`);
    const foreignId = await installSkill(a.workspaceId, a.userId, "Foreign");
    await commands.ensureProfile(b.workspaceId);
    const before = await countRuns(b.workspaceId);

    await expect(startRun(b.userId, b.workspaceId, foreignId)).rejects.toThrow(
      "That skill is not available. Enable it in Skills and try again.",
    );

    const after = await countRuns(b.workspaceId);
    expect(after).toBe(before);
  });

  it("re-using an Idempotency-Key with a different skillId is a 422 and starts nothing", async () => {
    const seeded = await seedWorkspace(db, `pin-e-${Date.now()}`);
    holder.auth = ownerAuth(seeded.userId, seeded.workspaceId);
    await commands.ensureProfile(seeded.workspaceId);
    const first = await installSkill(seeded.workspaceId, seeded.userId, "First");
    const second = await installSkill(seeded.workspaceId, seeded.userId, "Second");
    const key = "9c3f2a7b-4d10-4e5a-8f66-2b3c4d5e6f70";
    const post = (skillId: string) =>
      POST(
        new Request("https://axiom.test/api/v1/runs", {
          method: "POST",
          headers: { "content-type": "application/json", "idempotency-key": key },
          body: JSON.stringify({ objective: "Pinned", skillId }),
        }),
        undefined as never,
      );

    expect((await post(first)).status).toBe(201);
    const conflict = await post(second);
    expect(conflict.status).toBe(422);
    expect(await conflict.json()).toMatchObject({ code: "idempotency_conflict" });
  });
});
