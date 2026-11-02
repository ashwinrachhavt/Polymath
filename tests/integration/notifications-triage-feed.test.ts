import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { actionProposals, actionRevisions } from "@/domains/actions/schema";
import { auditEvents } from "@/domains/audit/schema";
import { agentProfiles, agentQuestions, agentRuns, runEvents } from "@/domains/agents/schema";
import { captureProposals, captures } from "@/domains/capture/schema";
import { makeTestDb, ownerAuth, seedWorkspace } from "../helpers/test-workspace";

/*
 * The triage seam against the real tables (spec: Notifications Zero-Hop
 * Triage, §1 verification). What the mocks cannot prove:
 *  - a waiting_input run with an open question surfaces as the question card,
 *    and the same run state without one reads as a parked in-flight run;
 *  - decided proposals and answered questions leave the Inbox, while expired
 *    ones stay with their flag set;
 *  - audit rows — in the database — produce no feed item at all;
 *  - the In-Flight count is countRunsInFlight's DB truth, not the page slice;
 *  - the CAS guards: a stale answer or a second dismissal matches zero rows
 *    and never resumes the run (sendFollowUp persists a message event before
 *    it signals eve, so zero message rows is the observable "never called").
 */

const handle = makeTestDb();
const holder: { db: ReturnType<typeof drizzle> | undefined } = { db: undefined };
const authHolder: { ctx: { userId: string; workspaceId: string; role: "owner" | "member" | "viewer" } } = {
  ctx: { userId: "none", workspaceId: "none", role: "owner" },
};
vi.mock("@/lib/auth", () => ({ getAuthContext: vi.fn(async () => authHolder.ctx) }));
vi.mock("@/lib/db", () => ({
  get db() {
    return holder.db;
  },
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { answerRunQuestion, dismissQuestionAction } from "@/app/(workspace)/polymath/[runId]/question-actions";
import { countRunsInFlight, listTriageFeed, triageTab, type TriageItem } from "@/domains/notifications/feed";

beforeAll(async () => {
  holder.db = handle?.db;
});
afterAll(async () => {
  await handle?.client.end();
});

let seedCounter = 0;
async function seedSuite(slug: string) {
  seedCounter += 1;
  const ws = await seedWorkspace(holder.db!, `${slug}-${Date.now()}-${seedCounter}`);
  const [profile] = await holder
    .db!.insert(agentProfiles)
    .values({ workspaceId: ws.workspaceId, name: `triage-${slug}` })
    .returning();
  return { ...ws, profileId: profile.id };
}

type RunState = (typeof agentRuns.$inferInsert)["state"];

function seedRun(workspaceId: string, profileId: string, state: RunState, objective = "Test objective") {
  return holder
    .db!.insert(agentRuns)
    .values({ workspaceId, agentProfileId: profileId, objective, policySnapshot: {}, state })
    .returning()
    .then(([run]) => run);
}

describe("listTriageFeed classification", () => {
  it("classifies every run state, joins open questions, and keeps decided and audit rows out", async () => {
    const ws = await seedSuite("triage-matrix");
    authHolder.ctx = ownerAuth(ws.userId, ws.workspaceId);

    const waitingWithQuestion = await seedRun(ws.workspaceId, ws.profileId, "waiting_input", "triage waiting run");
    const waitingParked = await seedRun(ws.workspaceId, ws.profileId, "waiting_input", "triage parked run");
    const queued = await seedRun(ws.workspaceId, ws.profileId, "queued");
    await seedRun(ws.workspaceId, ws.profileId, "running");
    await seedRun(ws.workspaceId, ws.profileId, "waiting_approval");
    const failed = await seedRun(ws.workspaceId, ws.profileId, "failed", `${"f".repeat(200)}\nsecond line`);
    const succeeded = await seedRun(
      ws.workspaceId,
      ws.profileId,
      "succeeded",
      "raw objective that the summary replaces",
    );
    await holder
      .db!.update(agentRuns)
      .set({ summary: "Read three pages about Zettel sitting" })
      .where(eq(agentRuns.id, succeeded.id));
    await seedRun(ws.workspaceId, ws.profileId, "cancelled");

    const [openQuestion] = await holder
      .db!.insert(agentQuestions)
      .values({
        workspaceId: ws.workspaceId,
        runId: waitingWithQuestion.id,
        question: "Who is this person?",
        context: "Mentioned in a forwarded email",
      })
      .returning();
    // An answered question is not triage: its run reads as a parked turn.
    await holder.db!.insert(agentQuestions).values({
      workspaceId: ws.workspaceId,
      runId: waitingParked.id,
      question: "An old question",
      state: "answered",
      answer: "already answered",
    });

    const [pendingProposal] = await holder
      .db!.insert(actionProposals)
      .values({
        workspaceId: ws.workspaceId,
        capability: "email.draft",
        riskClass: "external_write",
        title: "Send the introduction",
        expectedEffect: "Sends an email to Dana",
        dedupeKey: `triage-pending-${Date.now()}-${seedCounter}`,
      })
      .returning();
    const [revision] = await holder
      .db!.insert(actionRevisions)
      .values({ workspaceId: ws.workspaceId, proposalId: pendingProposal.id, revisionNumber: 1, payload: {} })
      .returning();
    // Decided, with its revision — excluded by status, not by a missing revision.
    const [approvedProposal] = await holder
      .db!.insert(actionProposals)
      .values({
        workspaceId: ws.workspaceId,
        capability: "email.draft",
        riskClass: "read",
        title: "An approved proposal",
        expectedEffect: "Nothing left to approve",
        dedupeKey: `triage-approved-${Date.now()}-${seedCounter}`,
        status: "approved",
      })
      .returning();
    await holder
      .db!.insert(actionRevisions)
      .values({ workspaceId: ws.workspaceId, proposalId: approvedProposal.id, revisionNumber: 1, payload: {} })
      .returning();
    // An expired decision stays in the Inbox with its flag set.
    const [expiredProposal] = await holder
      .db!.insert(actionProposals)
      .values({
        workspaceId: ws.workspaceId,
        capability: "email.draft",
        riskClass: "prepare",
        title: "An expired proposal",
        expectedEffect: "Sends an email",
        dedupeKey: `triage-expired-${Date.now()}-${seedCounter}`,
        expiresAt: new Date(Date.now() - 60_000),
      })
      .returning();
    await holder
      .db!.insert(actionRevisions)
      .values({ workspaceId: ws.workspaceId, proposalId: expiredProposal.id, revisionNumber: 1, payload: {} })
      .returning();

    const [capture] = await holder
      .db!.insert(captures)
      .values({
        workspaceId: ws.workspaceId,
        kind: "text",
        captureMode: "authored",
        rawPayload: {},
        text: "Call the dentist",
      })
      .returning();
    const [captureProposal] = await holder
      .db!.insert(captureProposals)
      .values({ workspaceId: ws.workspaceId, captureId: capture.id, kind: "task", payload: {} })
      .returning();
    await holder
      .db!.insert(captureProposals)
      .values({ workspaceId: ws.workspaceId, captureId: capture.id, kind: "note", payload: {}, status: "rejected" });

    await holder.db!.insert(auditEvents).values({
      workspaceId: ws.workspaceId,
      action: "run.feedback.up recorded",
      subjectType: "run",
      summary: "recorded feedback on a run",
    });

    const feed = await listTriageFeed(authHolder.ctx);

    // Questions: exactly the open one, carrying its row id and the getter's fields.
    const questions = feed.items.filter(
      (item): item is Extract<TriageItem, { kind: "question" }> => item.kind === "question",
    );
    expect(questions).toHaveLength(1);
    const question = questions[0];
    expect(question.id).toBe(openQuestion.id);
    expect(question.questionText).toBe("Who is this person?");
    expect(question.context).toBe("Mentioned in a forwarded email");
    expect(question.askedAt).toEqual(openQuestion.createdAt);
    expect(question.href).toBe(`/polymath/${waitingWithQuestion.id}`);

    // Decisions: the pending and expired ones, CAS fields bound to the revision.
    const decisions = feed.items.filter(
      (item): item is Extract<TriageItem, { kind: "decision" }> => item.kind === "decision",
    );
    expect(decisions.map((item) => item.id).sort()).toEqual(
      [pendingProposal.id, captureProposal.id, expiredProposal.id].sort(),
    );
    const actionDecision = decisions.find((item) => item.id === pendingProposal.id);
    if (!actionDecision || actionDecision.decision.decisionType !== "action") {
      return expect.unreachable("the pending action proposal must map to an action decision");
    }
    expect(actionDecision.decision.revisionId).toBe(revision.id);
    expect(actionDecision.decision.version).toBe(1);
    expect(actionDecision.decision.expired).toBe(false);
    expect(actionDecision.href).toBe(`/reviews?proposal=${pendingProposal.id}`);

    const captureDecision = decisions.find((item) => item.id === captureProposal.id);
    if (!captureDecision) return expect.unreachable("the pending capture proposal must map to a decision");
    expect(captureDecision.decision).toEqual({ decisionType: "capture" });
    expect(captureDecision.href).toBe(`/command-center/inbox?id=${capture.id}`);

    const expiredDecision = decisions.find((item) => item.id === expiredProposal.id);
    if (!expiredDecision || expiredDecision.decision.decisionType !== "action") {
      return expect.unreachable("the expired proposal must appear with its expired flag");
    }
    expect(expiredDecision.decision.expired).toBe(true);
    expect(decisions.find((item) => item.id === approvedProposal.id)).toBeUndefined();

    // Runs: one item per seeded run, in the right tab. The title policy prefers
    // the summary, else the objective's first line capped at 120.
    const runItemsInFeed = feed.items.filter(
      (item): item is Extract<TriageItem, { kind: "run" }> => item.kind === "run",
    );
    const runByRunId = new Map(runItemsInFeed.map((item) => [item.runId, item]));
    // One run, one card: the run with an open question surfaces only as the
    // question card, so seven of the eight runs have run items.
    expect(runByRunId.size).toBe(7);
    const succeededItem = runByRunId.get(succeeded.id);
    if (!succeededItem) return expect.unreachable("every seeded run must surface as a run item");
    expect(succeededItem.title).toBe("Read three pages about Zettel sitting");
    const failedItem = runByRunId.get(failed.id);
    if (!failedItem) return expect.unreachable("the failed run must surface as a run item");
    expect(failedItem.title).toBe(`${"f".repeat(117)}...`);
    expect(failedItem.stateLabel).toBe("Failed");
    expect(triageTab(runByRunId.get(waitingParked.id)!)).toBe("inFlight");
    expect(triageTab(runByRunId.get(queued.id)!)).toBe("inFlight");
    expect(triageTab(failedItem)).toBe("inbox");
    expect(triageTab(succeededItem)).toBe("activity");
    // The question run has NO run item anywhere — its question card owns it.
    expect(runByRunId.get(waitingWithQuestion.id)).toBeUndefined();
    const questionRunCard = feed.items.find(
      (item) => item.kind === "question" && item.runId === waitingWithQuestion.id,
    );
    expect(questionRunCard && triageTab(questionRunCard)).toBe("inbox");

    // Audit rows exist in the database and produce nothing: kinds are only
    // question, decision, run — and nothing links to /activity.
    for (const item of feed.items) {
      expect(["question", "decision", "run"]).toContain(item.kind);
      expect(item.href).not.toBe("/activity");
    }

    // A suspended run with a question outranks the queue; the queue's own
    // rank survives among decisions (external_write above prepare).
    expect(feed.items[0]?.kind).toBe("question");
    expect(feed.items.findIndex((item) => item.id === pendingProposal.id)).toBeLessThan(
      feed.items.findIndex((item) => item.id === captureProposal.id),
    );

    // Counts: the Inbox owns what needs the owner (the question, three
    // decisions including the expired one, the failed run); In-Flight is the
    // database's count of non-terminal runs, not the page's slice; Activity
    // is the finished runs.
    expect(feed.counts.inbox).toBe(5);
    expect(feed.counts.inFlight).toBe(4); // parked + queued + running + waiting_approval — the question run belongs to its card
    expect(feed.counts.inFlight).toBe(await countRunsInFlight(ws.workspaceId));
    expect(feed.counts.activity).toBe(2);
  });
});

describe("answerRunQuestion CAS guard", () => {
  it("refuses a stale card: an answered question returns ok:false and never resumes the run", async () => {
    const ws = await seedSuite("triage-cas");
    authHolder.ctx = ownerAuth(ws.userId, ws.workspaceId);
    const run = await seedRun(ws.workspaceId, ws.profileId, "waiting_input", "cas run");
    const [question] = await holder
      .db!.insert(agentQuestions)
      .values({
        workspaceId: ws.workspaceId,
        runId: run.id,
        question: "Which folder?",
        state: "answered",
        answer: "first answer",
      })
      .returning();

    const result = await answerRunQuestion({ runId: run.id, questionId: question.id, answer: "second answer" });
    expect(result.ok).toBe(false);

    // The stored answer is untouched, and no follow-up was written: the
    // follow-up persists a message event before it signals eve, so zero
    // message rows is the observable "never called".
    const [row] = await holder.db!.select().from(agentQuestions).where(eq(agentQuestions.id, question.id));
    expect(row?.state).toBe("answered");
    expect(row?.answer).toBe("first answer");
    const events = await holder.db!.select().from(runEvents).where(eq(runEvents.runId, run.id));
    expect(events.filter((event) => event.type === "message")).toHaveLength(0);
  });
});

describe("dismissQuestionAction", () => {
  it("dismisses an open question exactly once, scoped to the workspace", async () => {
    const ws = await seedSuite("triage-dismiss");
    const other = await seedSuite("triage-dismiss-other");
    authHolder.ctx = ownerAuth(ws.userId, ws.workspaceId);
    const run = await seedRun(ws.workspaceId, ws.profileId, "waiting_input", "dismiss run");
    const otherRun = await seedRun(other.workspaceId, other.profileId, "waiting_input", "foreign run");
    const [question] = await holder
      .db!.insert(agentQuestions)
      .values({ workspaceId: ws.workspaceId, runId: run.id, question: "Who is this person?" })
      .returning();
    const [foreignQuestion] = await holder
      .db!.insert(agentQuestions)
      .values({ workspaceId: other.workspaceId, runId: otherRun.id, question: "A foreign question" })
      .returning();

    // A question from another workspace and one already closed deny the same
    // way: no state change, no information about the other workspace.
    await expect(dismissQuestionAction({ questionId: foreignQuestion.id })).resolves.toEqual({
      ok: false,
      message: "That question is no longer open.",
    });

    await expect(dismissQuestionAction({ questionId: question.id })).resolves.toEqual({ ok: true });
    const [row] = await holder.db!.select().from(agentQuestions).where(eq(agentQuestions.id, question.id));
    expect(row?.state).toBe("dismissed");

    // The CAS guard: the second dismissal matches zero open rows.
    await expect(dismissQuestionAction({ questionId: question.id })).resolves.toEqual({
      ok: false,
      message: "That question is no longer open.",
    });
  });

  it("refuses a viewer and rejects malformed input", async () => {
    const ws = await seedSuite("triage-dismiss-viewer");
    authHolder.ctx = { userId: ws.userId, workspaceId: ws.workspaceId, role: "viewer" };
    await expect(dismissQuestionAction({ questionId: crypto.randomUUID() })).rejects.toThrow(/Requires member/);
    authHolder.ctx = ownerAuth(ws.userId, ws.workspaceId);
    await expect(dismissQuestionAction({ questionId: "not-a-uuid" })).resolves.toEqual({
      ok: false,
      message: "That question is no longer open.",
    });
  });
});
