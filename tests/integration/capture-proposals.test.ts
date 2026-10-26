import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { captureProposals } from "@/domains/capture/schema";
import { makeTestDb, ownerAuth, seedWorkspace } from "../helpers/test-workspace";

/*
 * ASH-314 proposal decisions: the system's read is an offer, never an act.
 * Accepting runs the same guarded conversion the manual buttons run and
 * records what the proposal made; rejecting touches only the proposal; a
 * decided proposal can never be decided again; and kinds with no honest
 * conversion path (contact) refuse instead of faking a record.
 */

const handle = makeTestDb();
const suite = handle ? describe : describe.skip;
let db: NonNullable<typeof handle>["db"];
let commands: typeof import("@/domains/capture/commands");
let queries: typeof import("@/domains/capture/queries");

beforeAll(async () => {
  if (!handle) return;
  ({ db } = handle);
  commands = await import("@/domains/capture/commands");
  queries = await import("@/domains/capture/queries");
});

afterAll(async () => {
  await handle?.client.end();
});

async function seed(slug: string) {
  const { userId, workspaceId } = await seedWorkspace(db, `${slug}-${Date.now()}`);
  return ownerAuth(userId, workspaceId);
}

async function propose(
  auth: { workspaceId: string; userId: string },
  captureId: string,
  kind: "task" | "note" | "contact" | "discard",
) {
  const [proposal] = await db
    .insert(captureProposals)
    .values({
      workspaceId: auth.workspaceId,
      captureId,
      kind,
      payload: {},
      rationale: `${kind} 0.87`,
      confidence: "0.87",
      createdBy: auth.userId,
      updatedBy: auth.userId,
    })
    .returning();
  return proposal;
}

suite("capture proposal decisions", () => {
  it("accepting a task proposal converts the capture and records the result", async () => {
    const auth = await seed("proposal-task");
    const capture = await commands.createCapture(auth, { text: "Renew the passport before the trip" });
    const proposal = await propose(auth, capture.id, "task");

    expect(await queries.listPendingCaptureProposals(auth, capture.id)).toHaveLength(1);

    const accepted = await commands.acceptCaptureProposal(auth, { proposalId: proposal.id });
    expect(accepted.resultType).toBe("task");
    expect(accepted.resultId).toBeTruthy();

    const [decided] = await db.select().from(captureProposals).where(eq(captureProposals.id, proposal.id));
    expect(decided.status).toBe("accepted");
    expect(decided.resultType).toBe("task");
    expect(decided.resultId).toBe(accepted.resultId);
    expect(decided.decidedBy).toBe(auth.userId);
    // The pending offer is gone and the capture carries the lineage edge.
    expect(await queries.listPendingCaptureProposals(auth, capture.id)).toHaveLength(0);
    const [row] = await db.select().from((await import("@/domains/capture/schema")).captures).where(eq((await import("@/domains/capture/schema")).captures.id, capture.id));
    expect(row.processingState).toBe("converted");
    expect(row.convertedType).toBe("task");
  });

  it("accepting a note proposal files the note with the original text kept", async () => {
    const auth = await seed("proposal-note");
    const capture = await commands.createCapture(auth, { text: "Reference: the taste principles doc" });
    const proposal = await propose(auth, capture.id, "note");

    const accepted = await commands.acceptCaptureProposal(auth, { proposalId: proposal.id });
    expect(accepted.resultType).toBe("note");

    const [decided] = await db.select().from(captureProposals).where(eq(captureProposals.id, proposal.id));
    expect(decided.status).toBe("accepted");
    expect(decided.resultType).toBe("note");
  });

  it("accepting a discard proposal archives the capture, owner-confirmed", async () => {
    const auth = await seed("proposal-discard");
    const capture = await commands.createCapture(auth, { text: "lorem ipsum noise" });
    const proposal = await propose(auth, capture.id, "discard");

    const accepted = await commands.acceptCaptureProposal(auth, { proposalId: proposal.id });
    expect(accepted).toMatchObject({ resultType: "discard", resultId: null });

    const [row] = await db.select().from((await import("@/domains/capture/schema")).captures).where(eq((await import("@/domains/capture/schema")).captures.id, capture.id));
    expect(row.processingState).toBe("discarded");
  });

  it("a contact proposal refuses to invent a record", async () => {
    const auth = await seed("proposal-contact");
    const capture = await commands.createCapture(auth, { text: "Met Priya from Acme at the meetup" });
    const proposal = await propose(auth, capture.id, "contact");

    await expect(commands.acceptCaptureProposal(auth, { proposalId: proposal.id })).rejects.toMatchObject({
      code: "conflict",
    });
    // The offer survives the refusal - the owner decides from the CRM page.
    expect(await queries.listPendingCaptureProposals(auth, capture.id)).toHaveLength(1);
  });

  it("a decided proposal can never be decided again, and reject leaves the capture alone", async () => {
    const auth = await seed("proposal-double");
    const capture = await commands.createCapture(auth, { text: "Maybe worth a note" });
    const proposal = await propose(auth, capture.id, "note");

    await commands.rejectCaptureProposal(auth, { proposalId: proposal.id });
    await expect(commands.rejectCaptureProposal(auth, { proposalId: proposal.id })).rejects.toMatchObject({
      code: "conflict",
    });
    await expect(commands.acceptCaptureProposal(auth, { proposalId: proposal.id })).rejects.toMatchObject({
      code: "conflict",
    });
    const [row] = await db.select().from((await import("@/domains/capture/schema")).captures).where(eq((await import("@/domains/capture/schema")).captures.id, capture.id));
    expect(row.processingState).toBe("unprocessed");
  });

  it("proposals never cross workspaces", async () => {
    const auth = await seed("proposal-tenant");
    const other = await seed("proposal-tenant-other");
    const capture = await commands.createCapture(auth, { text: "Tenant scoping check" });
    const proposal = await propose(auth, capture.id, "task");

    await expect(commands.acceptCaptureProposal(other, { proposalId: proposal.id })).rejects.toMatchObject({
      code: "not_found",
    });
    expect(await queries.listPendingCaptureProposals(other, capture.id)).toHaveLength(0);
  });

  it("marks only captures that carry a pending suggestion", async () => {
    const auth = await seed("proposal-marks");
    const withSuggestion = await commands.createCapture(auth, { text: "Has a suggestion" });
    const without = await commands.createCapture(auth, { text: "Plain capture" });
    await propose(auth, withSuggestion.id, "task");

    const marks = await queries.listCapturesWithPendingProposals(auth, [withSuggestion.id, without.id]);
    expect(marks.has(withSuggestion.id)).toBe(true);
    expect(marks.has(without.id)).toBe(false);
    expect((await queries.listCapturesWithPendingProposals(auth, [])).size).toBe(0);
  });
});
