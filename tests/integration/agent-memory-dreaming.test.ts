import { drizzle } from "drizzle-orm/postgres-js";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { agentRuns, runEvents } from "@/domains/agents/schema";
import { memoryNotes } from "@/domains/agents/memory-schema";
import { listMemoryNotes, loadMemoryIndex } from "@/domains/agents/memory";
import { runDreamPass } from "@/domains/agents/memory-dreaming";
import { makeTestDb, ownerAuth, seedWorkspace } from "../helpers/test-workspace";

/*
 * A dreaming pass against a real Postgres, with the MODEL MOCKED.
 *
 * The model is mocked on purpose: these tests prove the pass's own contract —
 * what it writes, what it corrects, that a second run changes nothing, and
 * that one workspace's notes never reach another's prompt — and a live call
 * would make them cost money and pass or fail on model mood. The one thing a
 * mock cannot prove (that a real model returns useful notes) is not claimed
 * here; tests/unit/memory-index.test.ts covers the pure rules.
 */

const handle = makeTestDb();
const suite = handle ? describe : describe.skip;
const holder: { db: ReturnType<typeof drizzle> | undefined } = { db: undefined };
vi.mock("@/lib/db", () => ({
  get db() {
    return holder.db;
  },
}));
vi.mock("@/lib/db-transaction", () => ({
  get withTransaction() {
    return (fn: Parameters<typeof import("@/lib/db-transaction").withTransaction>[0]) =>
      (holder.db!.transaction as typeof import("@/lib/db-transaction").withTransaction)(fn);
  },
}));

/** The proposal system prompt's first line — what tells the two calls apart. */
const PROPOSE_MARKER = "You maintain a small memory";
/** A stand-in model: identity is never read once `generateText` is mocked. */
const MODEL = {} as never;

const generateText = vi.hoisted(() => vi.fn());
vi.mock("ai", async (importOriginal) => ({
  ...(await importOriginal<typeof import("ai")>()),
  generateText,
}));

type Reply = { text: string; finishReason?: "stop" | "content-filter" | "length" };

let proposeReply: Reply;
let checkReply: Reply;

beforeAll(() => {
  if (!handle) return;
  holder.db = handle.db;
  generateText.mockImplementation(async (args: { system: string }) =>
    args.system.startsWith(PROPOSE_MARKER)
      ? { text: proposeReply.text, finishReason: proposeReply.finishReason ?? "stop" }
      : { text: checkReply.text, finishReason: checkReply.finishReason ?? "stop" },
  );
});
afterAll(async () => {
  await handle?.client.end();
});
beforeEach(() => {
  generateText.mockClear();
  proposeReply = { text: '{"notes":[]}' };
  checkReply = { text: '{"verdicts":[],"duplicates":[]}' };
});

async function seedRun(userId: string, workspaceId: string, lines: string[], createdAt?: Date) {
  const [run] = await holder
    .db!.insert(agentRuns)
    .values({
      workspaceId,
      agentProfileId: await profileId(workspaceId),
      createdBy: userId,
      objective: lines[0] ?? "a question",
      subjects: [],
      state: "succeeded",
      policySnapshot: {},
      startedAt: sql`now() - interval '2 minutes'`,
      endedAt: sql`now() - interval '1 minute'`,
      ...(createdAt ? { createdAt } : {}),
    })
    .returning({ id: agentRuns.id });
  let sequence = 0;
  for (const line of lines) {
    const [role, ...rest] = line.split(": ");
    await holder.db!.insert(runEvents).values({
      workspaceId,
      runId: run.id,
      sequence: ++sequence,
      type: "message",
      data: { role: role === "assistant" ? "assistant" : "user", content: rest.join(": ") },
    });
  }
  return run;
}

async function profileId(workspaceId: string) {
  // Every run needs a profile; seedWorkspace does not make one, and the
  // dreaming pass never reads it.
  const { agentProfiles } = await import("@/domains/agents/schema");
  const [existing] = await holder
    .db!.select({ id: agentProfiles.id })
    .from(agentProfiles)
    .where(eq(agentProfiles.workspaceId, workspaceId))
    .limit(1);
  if (existing) return existing.id;
  const [created] = await holder
    .db!.insert(agentProfiles)
    .values({ workspaceId, name: "polymath", modelPolicy: {}, allowedTools: [], allowedAccounts: [] })
    .returning({ id: agentProfiles.id });
  return created.id;
}

async function notesFor(workspaceId: string, userId: string) {
  return holder
    .db!.select()
    .from(memoryNotes)
    .where(and(eq(memoryNotes.workspaceId, workspaceId), eq(memoryNotes.userId, userId)))
    .orderBy(memoryNotes.createdAt);
}

suite("dreaming over fixture transcripts (model mocked)", () => {
  it("creates notes from a transcript, with provenance", async () => {
    const seeded = await seedWorkspace(holder.db!, `dream-create-${Date.now()}`);
    const auth = ownerAuth(seeded.userId, seeded.workspaceId);
    const run = await seedRun(seeded.userId, seeded.workspaceId, [
      "user: I always want short answers, no preamble.",
      "assistant: Understood — short answers from here.",
    ]);
    proposeReply = {
      text: JSON.stringify({
        notes: [
          { body: "Prefers short answers with no preamble.", quote: "I always want short answers, no preamble." },
        ],
      }),
    };

    const summary = await runDreamPass(auth, { model: MODEL });
    expect(summary.model.propose).toBe("notes");
    expect(summary.created).toBe(1);

    const notes = await notesFor(seeded.workspaceId, seeded.userId);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({
      body: "Prefers short answers with no preamble.",
      status: "unconfirmed",
      sourceKind: "run",
      sourceId: run.id,
    });
  });

  it("corrects a note the transcript contradicts, keeping the old wording", async () => {
    const seeded = await seedWorkspace(holder.db!, `dream-correct-${Date.now()}`);
    const auth = ownerAuth(seeded.userId, seeded.workspaceId);
    await seedRun(seeded.userId, seeded.workspaceId, ["user: I moved to Lisbon last month."]);
    const [existing] = await holder
      .db!.insert(memoryNotes)
      .values({
        workspaceId: seeded.workspaceId,
        userId: seeded.userId,
        body: "Lives in Berlin.",
        key: "lives in berlin",
        status: "confirmed",
      })
      .returning();

    checkReply = {
      text: JSON.stringify({ verdicts: [{ id: existing.id, verdict: "correct", body: "Lives in Lisbon." }] }),
    };

    const summary = await runDreamPass(auth, { model: MODEL });
    expect(summary.corrected).toBe(1);

    const [corrected] = await notesFor(seeded.workspaceId, seeded.userId);
    expect(corrected).toMatchObject({
      body: "Lives in Lisbon.",
      status: "corrected",
      previousBody: "Lives in Berlin.",
    });
  });

  it("is idempotent: a second pass with no new transcripts changes nothing and calls no model", async () => {
    const seeded = await seedWorkspace(holder.db!, `dream-idem-${Date.now()}`);
    const auth = ownerAuth(seeded.userId, seeded.workspaceId);
    await seedRun(seeded.userId, seeded.workspaceId, ["user: I write in TypeScript.", "assistant: Noted."]);
    proposeReply = {
      text: JSON.stringify({ notes: [{ body: "Writes in TypeScript.", quote: "I write in TypeScript." }] }),
    };

    const first = await runDreamPass(auth, { model: MODEL });
    expect(first.created).toBe(1);
    const afterFirst = await notesFor(seeded.workspaceId, seeded.userId);
    const callsAfterFirst = generateText.mock.calls.length;

    const second = await runDreamPass(auth, { model: MODEL });
    expect(second.transcripts).toBe(0);
    expect(second.created).toBe(0);
    expect(second.corrected).toBe(0);
    expect(generateText.mock.calls.length).toBe(callsAfterFirst);

    const afterSecond = await notesFor(seeded.workspaceId, seeded.userId);
    expect(afterSecond.map((n) => [n.id, n.body, n.updatedAt.toISOString()])).toEqual(
      afterFirst.map((n) => [n.id, n.body, n.updatedAt.toISOString()]),
    );
  });

  it("never leaks another workspace's notes into the checked set or the proposal", async () => {
    const alpha = await seedWorkspace(holder.db!, `dream-alpha-${Date.now()}`);
    const beta = await seedWorkspace(holder.db!, `dream-beta-${Date.now()}`);
    const betaAuth = ownerAuth(beta.userId, beta.workspaceId);
    await holder.db!.insert(memoryNotes).values({
      workspaceId: alpha.workspaceId,
      userId: alpha.userId,
      body: "ALPHA ONLY: prefers weekly summaries on Fridays.",
      key: "alpha only: prefers weekly summaries on fridays",
    });
    await seedRun(beta.userId, beta.workspaceId, ["user: I keep a daily journal."]);

    proposeReply = {
      text: JSON.stringify({ notes: [{ body: "Keeps a daily journal.", quote: "I keep a daily journal." }] }),
    };

    const summary = await runDreamPass(betaAuth, { model: MODEL });
    expect(summary.created).toBe(1);

    // The check call only runs when the owner has notes; beta has none yet, so
    // the proposer is the only call. Assert the prompt still never carried
    // alpha's text, and beta's store holds only beta's note.
    const prompts = generateText.mock.calls.map((call) => String((call[0] as { prompt?: string }).prompt ?? ""));
    expect(prompts.some((prompt) => prompt.includes("ALPHA ONLY"))).toBe(false);
    const betaNotes = await notesFor(beta.workspaceId, beta.userId);
    expect(betaNotes.map((n) => n.body)).toEqual(["Keeps a daily journal."]);
    expect(betaNotes.some((n) => n.body.includes("ALPHA"))).toBe(false);
  });

  it("shows the ONLY the owner's notes: a second user in the same workspace gets a separate store", async () => {
    const seeded = await seedWorkspace(holder.db!, `dream-users-${Date.now()}`);
    const auth = ownerAuth(seeded.userId, seeded.workspaceId);
    const { users } = await import("@/domains/identity/schema");
    const [other] = await holder
      .db!.insert(users)
      .values({ clerkUserId: `other_${Date.now()}` })
      .returning();
    await holder.db!.insert(memoryNotes).values({
      workspaceId: seeded.workspaceId,
      userId: other.id,
      body: "SOMEONE ELSE'S note.",
      key: "someone else's note",
    });
    await seedRun(seeded.userId, seeded.workspaceId, ["user: I prefer tables to prose."]);
    proposeReply = { text: '{"notes":[]}' };

    await runDreamPass(auth, { model: MODEL });
    const prompts = generateText.mock.calls.map((call) => String((call[0] as { prompt?: string }).prompt ?? ""));
    expect(prompts.some((prompt) => prompt.includes("SOMEONE ELSE'S"))).toBe(false);
    // And the owner's injected index does not carry the other user's note.
    expect(await loadMemoryIndex(auth)).toBeNull();
  });

  it("merges two notes the checker names as restatements, keeping the earlier one live", async () => {
    const seeded = await seedWorkspace(holder.db!, `dream-merge-${Date.now()}`);
    const auth = ownerAuth(seeded.userId, seeded.workspaceId);
    await seedRun(seeded.userId, seeded.workspaceId, ["user: We ship on Fridays."]);
    const [keep, fold] = await holder
      .db!.insert(memoryNotes)
      .values([
        { workspaceId: seeded.workspaceId, userId: seeded.userId, body: "Ships on Fridays.", key: "ships on fridays" },
        {
          workspaceId: seeded.workspaceId,
          userId: seeded.userId,
          body: "Friday is the release day.",
          key: "friday is the release day",
        },
      ])
      .returning();

    checkReply = { text: JSON.stringify({ verdicts: [], duplicates: [{ keepId: keep.id, dropId: fold.id }] }) };
    const summary = await runDreamPass(auth, { model: MODEL });
    expect(summary.merged).toBe(1);

    // The kept note stays live and injected; the folded one is archived, not
    // deleted, so its provenance remains readable.
    const live = await listMemoryNotes(auth);
    expect(live.map((n) => n.id)).toEqual([keep.id]);
    const injected = await loadMemoryIndex(auth);
    expect(injected).toContain("Ships on Fridays.");
    expect(injected).not.toContain("Friday is the release day.");
    const [folded] = await holder.db!.select().from(memoryNotes).where(eq(memoryNotes.id, fold.id));
    expect(folded.archivedAt).not.toBeNull();
  });

  it("treats refusal, empty output and invalid JSON as distinct, and writes nothing", async () => {
    const cases: Array<{ reply: Reply; expect: "refused" | "empty" | "invalid" }> = [
      { reply: { text: "", finishReason: "content-filter" }, expect: "refused" },
      { reply: { text: "" }, expect: "empty" },
      { reply: { text: "not json at all" }, expect: "invalid" },
    ];
    for (const [i, entry] of cases.entries()) {
      const seeded = await seedWorkspace(holder.db!, `dream-bad-${i}-${Date.now()}`);
      const auth = ownerAuth(seeded.userId, seeded.workspaceId);
      await seedRun(seeded.userId, seeded.workspaceId, ["user: Anything at all."]);
      proposeReply = entry.reply;
      const summary = await runDreamPass(auth, { model: MODEL });
      expect(summary.model.propose).toBe(entry.expect);
      expect(summary.created).toBe(0);
      expect(await notesFor(seeded.workspaceId, seeded.userId)).toHaveLength(0);
    }
  });

  it("a corrected note's new text is what the next session's injection sees", async () => {
    const seeded = await seedWorkspace(holder.db!, `dream-inject-${Date.now()}`);
    const auth = ownerAuth(seeded.userId, seeded.workspaceId);
    await seedRun(seeded.userId, seeded.workspaceId, ["user: We use Vercel, not AWS, for hosting."]);
    const [existing] = await holder
      .db!.insert(memoryNotes)
      .values({
        workspaceId: seeded.workspaceId,
        userId: seeded.userId,
        body: "Hosts on AWS.",
        key: "hosts on aws",
        status: "confirmed",
      })
      .returning();

    // Before: the wrong note is what a session would have been given.
    expect(await loadMemoryIndex(auth)).toContain("Hosts on AWS.");

    checkReply = {
      text: JSON.stringify({ verdicts: [{ id: existing.id, verdict: "correct", body: "Hosts on Vercel, not AWS." }] }),
    };
    await runDreamPass(auth, { model: MODEL });

    // After: the corrected wording is injected, the old one is gone.
    const injected = await loadMemoryIndex(auth);
    expect(injected).toContain("Hosts on Vercel, not AWS.");
    expect(injected).not.toContain("Hosts on AWS.");
    const notes = await listMemoryNotes(auth);
    expect(notes[0].status).toBe("corrected");
  });
});
