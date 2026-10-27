import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { actionAttempts, actionProposals, actionRevisions } from "@/domains/actions/schema";
import { agentProfiles, agentRuns } from "@/domains/agents/schema";
import { artifacts } from "@/domains/knowledge/schema";
import { tasks, taskLinks } from "@/domains/work/schema";
import { makeTestDb, ownerAuth, seedWorkspace } from "../helpers/test-workspace";

/*
 * Run follow-ups become tasks only through the owner's approval, and the
 * approval path enforces the same checks as the calendar executor, because
 * the review queue is only "one checkpoint" if the local one is not a way
 * around it:
 *  1. the run's frozen snapshot still allows tasks.create;
 *  2. the run is still non-terminal;
 *  3. a retried approval reads the settled attempt instead of creating a
 *     second task.
 *
 * Skipped unless TEST_DATABASE_URL points at a migrated scratch database.
 */

const handle = makeTestDb();
const suite = handle ? describe : describe.skip;
let db: NonNullable<typeof handle>["db"];
let proposals: typeof import("@/domains/work/proposals");

beforeAll(async () => {
  if (!handle) return;
  ({ db } = handle);
  proposals = await import("@/domains/work/proposals");
});

afterAll(async () => {
  await handle?.client.end();
});

async function seed(slug: string) {
  const { userId, workspaceId } = await seedWorkspace(db, `${slug}-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`);
  return { auth: ownerAuth(userId, workspaceId), userId, workspaceId };
}

type RunState = typeof agentRuns.$inferInsert.state;

async function seedRun(workspaceId: string, userId: string, allowedTools: string[], state: RunState = "running") {
  const [profile] = await db
    .insert(agentProfiles)
    .values({ workspaceId, name: `alfred-${crypto.randomUUID()}` })
    .returning();
  const [run] = await db
    .insert(agentRuns)
    .values({
      workspaceId,
      agentProfileId: profile.id,
      objective: "Read the lease and list follow-ups",
      state,
      policySnapshot: { allowedTools },
      createdBy: userId,
    })
    .returning();
  return run.id;
}

async function propose(auth: ReturnType<typeof ownerAuth>, runId: string, dedupeId = crypto.randomUUID()) {
  const { proposalId, deduplicated } = await proposals.proposeTask(auth, {
    title: "Follow up on the lease renewal clause",
    description: "Section 7 sets a 60-day notice window.",
    estimateMinutes: 30,
    links: [{ targetType: "document", targetId: crypto.randomUUID(), label: "Lease" }],
    dedupeKey: `run-${runId}-${dedupeId}`,
    runId,
  });
  const [[row], [revision]] = await Promise.all([
    db.select().from(actionProposals).where(eq(actionProposals.id, proposalId)),
    db.select().from(actionRevisions).where(eq(actionRevisions.proposalId, proposalId)),
  ]);
  return { proposalId, deduplicated, version: row.version, revisionId: revision.id };
}

async function tasksFor(workspaceId: string) {
  // Prose lives on the note, so the title is joined in rather than selected
  // from the dropped task column.
  return db
    .select({ task: tasks, title: artifacts.title })
    .from(tasks)
    .innerJoin(artifacts, and(eq(artifacts.id, tasks.noteId), eq(artifacts.workspaceId, tasks.workspaceId)))
    .where(eq(tasks.workspaceId, workspaceId));
}

suite("task proposal execution checks", () => {
  it("approval creates the task with its source links, and a replay creates none twice", async () => {
    const { auth, userId, workspaceId } = await seed("task-exec-ok");
    const runId = await seedRun(workspaceId, userId, ["tasks.create"]);
    const { proposalId, version, revisionId } = await propose(auth, runId);

    const first = await proposals.approveTaskProposal(auth, { proposalId, expectedVersion: version, revisionId });
    expect(first).toMatchObject({ status: "executed" });
    const created = await tasksFor(workspaceId);
    expect(created).toHaveLength(1);
    expect(created[0]!.title).toBe("Follow up on the lease renewal clause");
    expect(created[0]!.task.estimateMinutes).toBe(30);
    const links = await db.select().from(taskLinks).where(eq(taskLinks.taskId, created[0]!.task.id));
    expect(links).toHaveLength(1);
    expect(links[0].targetType).toBe("document");

    // A retried approval reads the settled attempt: same task, no second row.
    const replay = await proposals.approveTaskProposal(auth, { proposalId, expectedVersion: version, revisionId });
    expect(replay).toMatchObject({ status: "executed" });
    expect((replay as { taskId?: string }).taskId).toBe((first as { taskId?: string }).taskId);
    expect(await tasksFor(workspaceId)).toHaveLength(1);
  });

  it("the same dedupe key resolves one proposal, not two", async () => {
    const { auth, userId, workspaceId } = await seed("task-exec-dedupe");
    const runId = await seedRun(workspaceId, userId, ["tasks.create"]);
    const a = await propose(auth, runId, "passage-9");
    const b = await propose(auth, runId, "passage-9");
    expect(a.proposalId).toBe(b.proposalId);
    expect(b.deduplicated).toBe(true);
    expect(await db.select().from(actionRevisions).where(eq(actionRevisions.proposalId, a.proposalId))).toHaveLength(1);
  });

  it("refuses when the run's snapshot does not grant tasks.create", async () => {
    const { auth, userId, workspaceId } = await seed("task-exec-cap");
    const runId = await seedRun(workspaceId, userId, ["tasks.read"]);
    const { proposalId, version, revisionId } = await propose(auth, runId);

    await expect(
      proposals.approveTaskProposal(auth, { proposalId, expectedVersion: version, revisionId }),
    ).rejects.toBeInstanceOf(proposals.TaskExecuteNotAllowedError);
    expect(await tasksFor(workspaceId)).toHaveLength(0);
    expect(await db.select().from(actionAttempts).where(eq(actionAttempts.proposalId, proposalId))).toHaveLength(0);
  });

  it("refuses when the run that proposed it is cancelled", async () => {
    const { auth, userId, workspaceId } = await seed("task-exec-run");
    const runId = await seedRun(workspaceId, userId, ["tasks.create"], "cancelled");
    const { proposalId, version, revisionId } = await propose(auth, runId);

    await expect(
      proposals.approveTaskProposal(auth, { proposalId, expectedVersion: version, revisionId }),
    ).rejects.toBeInstanceOf(proposals.TaskExecuteNotAllowedError);
    expect(await tasksFor(workspaceId)).toHaveLength(0);
  });

  it("a foreign workspace cannot approve the proposal", async () => {
    const { auth, userId, workspaceId } = await seed("task-exec-home");
    const other = await seed("task-exec-away");
    const runId = await seedRun(workspaceId, userId, ["tasks.create"]);
    const { proposalId, version, revisionId } = await propose(auth, runId);

    await expect(
      proposals.approveTaskProposal(other.auth, { proposalId, expectedVersion: version, revisionId }),
    ).rejects.toThrow();
    expect(await tasksFor(workspaceId)).toHaveLength(0);
    expect(await tasksFor(other.workspaceId)).toHaveLength(0);
  });
});
