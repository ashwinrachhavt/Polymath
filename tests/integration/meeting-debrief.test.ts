import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { actionAttempts, actionProposals, actionRevisions } from "@/domains/actions/schema";
import { artifacts, artifactVersions } from "@/domains/knowledge/schema";
import { tasks } from "@/domains/work/schema";
import { makeTestDb, ownerAuth, seedWorkspace } from "../helpers/test-workspace";

/*
 * The meeting debrief (ASH-303), end to end against a scratch database:
 *  1. one pass turns a transcript into a batch of task, note and follow-up
 *     proposals sharing one dedupe root, and writes nothing else;
 *  2. follow-ups land as task proposals titled "Follow up ..." (the calendar
 *     follow-up kind is not on main);
 *  3. a retried debrief resolves the same proposals instead of doubling the
 *     queue;
 *  4. approving a note proposal creates exactly one note, and a retried
 *     approval reads the settled attempt instead of creating a second;
 *  5. approving a task proposal creates exactly one task;
 *  6. a missing artifact and an empty transcript refuse before any proposal.
 *
 * The generation provider is a mock; the real seam is
 * integrations/generation/provider. Skipped unless TEST_DATABASE_URL points
 * at a migrated scratch database.
 */

const TRANSCRIPT = "Priya: can you send the Q3 roadmap by Friday? Marcus: I still owe everyone the launch date. Decided: annual billing stays.";

const DRAFT = JSON.stringify({
  tasks: [{ title: "Send the Q3 roadmap", description: "Priya asked for it by Friday." }],
  notes: [{ title: "Pricing decision", markdown: "**Decided:** annual billing stays." }],
  followUps: [{ summary: "confirm the launch date", person: "Marcus" }],
});

const mockProvider = {
  name: "test:mock",
  registryId: "mock",
  generate: async () => ({ text: DRAFT }),
};

const handle = makeTestDb();
const suite = handle ? describe : describe.skip;
let db: NonNullable<typeof handle>["db"];
let debrief: typeof import("@/domains/knowledge/meeting-debrief");
let noteProposals: typeof import("@/domains/knowledge/note-proposals");
let taskProposals: typeof import("@/domains/work/proposals");

beforeAll(async () => {
  if (!handle) return;
  ({ db } = handle);
  debrief = await import("@/domains/knowledge/meeting-debrief");
  noteProposals = await import("@/domains/knowledge/note-proposals");
  taskProposals = await import("@/domains/work/proposals");
});

afterAll(async () => {
  await handle?.client.end();
});

async function seed(slug: string) {
  const { userId, workspaceId } = await seedWorkspace(db, `${slug}-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`);
  return { auth: ownerAuth(userId, workspaceId), userId, workspaceId };
}

async function seedTranscript(workspaceId: string, userId: string, plainText: string | null = TRANSCRIPT) {
  const [artifact] = await db
    .insert(artifacts)
    .values({ workspaceId, kind: "transcript", title: "Weekly sync", status: "reviewed" })
    .returning();
  const [v1] = await db
    .insert(artifactVersions)
    .values({ workspaceId, artifactId: artifact.id, versionNumber: 1, content: { type: "doc", content: [] }, plainText, reason: "created", createdBy: userId })
    .returning();
  await db.update(artifacts).set({ currentVersionId: v1.id }).where(eq(artifacts.id, artifact.id));
  return artifact;
}

suite("meeting debrief", () => {
  it("turns one transcript into a batch of task, note and follow-up proposals", async () => {
    const { auth, workspaceId } = await seed("debrief-batch");
    const artifact = await seedTranscript(workspaceId, auth.userId);

    const result = await debrief.debriefMeetingArtifact(auth, artifact.id, { provider: mockProvider });

    expect(result.taskProposalIds).toHaveLength(1);
    expect(result.noteProposalIds).toHaveLength(1);
    expect(result.followUpProposalIds).toHaveLength(1);
    expect(result.deduplicated).toBe(0);
    expect(result.batchKey).toBe(`meeting-debrief:${artifact.id}`);

    const rows = await db
      .select({ capability: actionProposals.capability, dedupeKey: actionProposals.dedupeKey, title: actionProposals.title, status: actionProposals.status })
      .from(actionProposals)
      .where(eq(actionProposals.workspaceId, workspaceId));
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row.status).toBe("pending");
      expect(row.dedupeKey).toMatch(new RegExp(`^(tasks|notes):meeting-debrief:${artifact.id}:`));
    }
    const followUp = rows.find((r) => r.capability === "tasks.create" && r.title.startsWith("Add task: Follow up"));
    expect(followUp?.title).toBe("Add task: Follow up with Marcus: confirm the launch date");
    expect(rows.some((r) => r.capability === "notes.create")).toBe(true);

    // The debrief proposes; it never writes the task or the note itself.
    expect(await db.select({ id: tasks.id }).from(tasks).where(eq(tasks.workspaceId, workspaceId))).toHaveLength(0);
  });

  it("resolves the same proposals on a retried debrief", async () => {
    const { auth, workspaceId } = await seed("debrief-replay");
    const artifact = await seedTranscript(workspaceId, auth.userId);

    const first = await debrief.debriefMeetingArtifact(auth, artifact.id, { provider: mockProvider });
    const second = await debrief.debriefMeetingArtifact(auth, artifact.id, { provider: mockProvider });

    expect(second.taskProposalIds).toHaveLength(0);
    expect(second.noteProposalIds).toHaveLength(0);
    expect(second.followUpProposalIds).toHaveLength(0);
    expect(second.deduplicated).toBe(3);
    const count = await db.select({ id: actionProposals.id }).from(actionProposals).where(eq(actionProposals.workspaceId, workspaceId));
    expect(count).toHaveLength(3);
    expect(first.batchKey).toBe(second.batchKey);
  });

  it("creates exactly one note per approval, even when the approval is retried", async () => {
    const { auth, workspaceId } = await seed("debrief-note-approve");
    const artifact = await seedTranscript(workspaceId, auth.userId);
    const result = await debrief.debriefMeetingArtifact(auth, artifact.id, { provider: mockProvider });
    const proposalId = result.noteProposalIds[0]!;

    const [revision] = await db
      .select()
      .from(actionRevisions)
      .where(and(eq(actionRevisions.proposalId, proposalId), eq(actionRevisions.workspaceId, workspaceId)));

    const first = await noteProposals.approveNoteProposal(auth, { proposalId, expectedVersion: 1, revisionId: revision!.id });
    expect(first.status).toBe("executed");
    const noteId = first.status === "executed" ? first.artifactId : null;

    const retry = await noteProposals.approveNoteProposal(auth, { proposalId, expectedVersion: 1, revisionId: revision!.id });
    expect(retry).toEqual(first);

    const notes = await db
      .select({ id: artifacts.id, title: artifacts.title })
      .from(artifacts)
      .where(and(eq(artifacts.workspaceId, workspaceId), eq(artifacts.id, noteId!)));
    expect(notes).toHaveLength(1);
    expect(notes[0]!.title).toBe("Pricing decision");

    const [attempt] = await db
      .select()
      .from(actionAttempts)
      .where(and(eq(actionAttempts.proposalId, proposalId), eq(actionAttempts.workspaceId, workspaceId)));
    expect(attempt!.status).toBe("succeeded");
    expect(attempt!.providerObjectId).toBe(noteId);
  });

  it("creates exactly one task when a debrief task proposal is approved", async () => {
    const { auth, workspaceId } = await seed("debrief-task-approve");
    const artifact = await seedTranscript(workspaceId, auth.userId);
    const result = await debrief.debriefMeetingArtifact(auth, artifact.id, { provider: mockProvider });
    const proposalId = result.taskProposalIds[0]!;

    const [revision] = await db
      .select()
      .from(actionRevisions)
      .where(and(eq(actionRevisions.proposalId, proposalId), eq(actionRevisions.workspaceId, workspaceId)));

    const outcome = await taskProposals.approveTaskProposal(auth, { proposalId, expectedVersion: 1, revisionId: revision!.id });
    expect(outcome.status).toBe("executed");

    // The title lives on the task's note, so it is joined in rather than read
    // from the dropped task column.
    const rows = await db
      .select({ title: artifacts.title })
      .from(tasks)
      .innerJoin(artifacts, and(eq(artifacts.id, tasks.noteId), eq(artifacts.workspaceId, tasks.workspaceId)))
      .where(eq(tasks.workspaceId, workspaceId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.title).toBe("Send the Q3 roadmap");
  });

  it("refuses a missing artifact, a non-transcript, and an empty transcript before proposing", async () => {
    const { auth, workspaceId, userId } = await seed("debrief-refusals");
    await expect(
      debrief.debriefMeetingArtifact(auth, crypto.randomUUID(), { provider: mockProvider }),
    ).rejects.toThrowError(/does not exist/);

    // A generated note is not a meeting transcript and must not debrief.
    const [note] = await db
      .insert(artifacts)
      .values({ workspaceId, kind: "note", title: "Learning path", status: "reviewed" })
      .returning();
    const [noteV1] = await db
      .insert(artifactVersions)
      .values({ workspaceId, artifactId: note.id, versionNumber: 1, content: { type: "doc", content: [] }, plainText: "Some generated body.", reason: "created", createdBy: userId })
      .returning();
    await db.update(artifacts).set({ currentVersionId: noteV1.id }).where(eq(artifacts.id, note.id));
    await expect(debrief.debriefMeetingArtifact(auth, note.id, { provider: mockProvider })).rejects.toThrowError(/Only a meeting transcript/);

    const empty = await seedTranscript(workspaceId, userId, null);
    await expect(debrief.debriefMeetingArtifact(auth, empty.id, { provider: mockProvider })).rejects.toThrowError(/no text to debrief/);

    expect(await db.select({ id: actionProposals.id }).from(actionProposals).where(eq(actionProposals.workspaceId, workspaceId))).toHaveLength(0);
  });

  it("surfaces an unusable model answer without proposing anything", async () => {
    const { auth, workspaceId } = await seed("debrief-bad-answer");
    const artifact = await seedTranscript(workspaceId, auth.userId);
    const bad = { ...mockProvider, generate: async () => ({ text: "i could not read that" }) };
    await expect(debrief.debriefMeetingArtifact(auth, artifact.id, { provider: bad })).rejects.toThrowError(/not JSON/);
    expect(await db.select({ id: actionProposals.id }).from(actionProposals).where(eq(actionProposals.workspaceId, workspaceId))).toHaveLength(0);
  });
});
