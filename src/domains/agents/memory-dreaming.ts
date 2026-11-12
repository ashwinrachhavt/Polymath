import { and, asc, desc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { generateText } from "ai";
import type { ClaimedOutboxEvent, OutboxHandler } from "@/domains/audit/outbox";
import { chatModel, DEFAULT_MODEL_ID, modelById } from "@/domains/agents/models";
import type { AuthContext } from "@/domains/identity/resolve";
import { db } from "@/lib/db";
import { withTransaction } from "@/lib/db-transaction";
import {
  MEMORY_NOTE_MAX_CHARS,
  memoryNoteKey,
  normalizeMemoryBody,
  upsertMemoryNote,
  correctMemoryNote,
  mergeMemoryNotes,
} from "./memory";
import { memoryDreams, memoryNotes } from "./memory-schema";
import { agentRuns, runEvents } from "./schema";

/*
 * Dreaming: the offline consolidation pass over a person's transcripts.
 *
 * What it does, in this order, and why each step exists:
 *   1. Reads transcripts newer than the last pass's watermark. No new
 *      transcripts means no model call and no writes — that is what makes a
 *      second run a no-op.
 *   2. Proposes a few notes from them. Fewer, better notes win (Anthropic's
 *      eval: ~10 notes beat 413), so the proposal count is capped hard and
 *      the prompt asks for observations that recur or that a future session
 *      would need.
 *   3. Checks every proposed note AND every existing note against the
 *      transcript text. A note the transcript contradicts is corrected or
 *      dropped. A wrong injected note repeats its error in every session, so
 *      this step is the one that matters most.
 *   4. Merges duplicates: a proposal that restates an existing note collapses
 *      onto the existing row instead of being written again.
 *
 * Every model call is one `generateText` with `json: true`-shaped parsing.
 * Refusal, empty output and invalid JSON are three distinct outcomes and are
 * counted separately in the pass summary; none of them throws.
 */

export const MEMORY_DREAM_TOPIC = "agents.memory_dream_requested";

/** How many finished runs one pass reads. Bounded so a busy workspace stays cheap. */
const MAX_TRANSCRIPTS = 8;
/** Characters of transcript text per run handed to the model. */
const MAX_TRANSCRIPT_CHARS = 6000;
/** Proposed notes per pass. The brief's "fewer, high-quality notes" rule. */
const MAX_PROPOSED = 6;
/** Existing notes re-checked per pass. */
const MAX_EXISTING_CHECKED = 30;
const NOTE_MAX = MEMORY_NOTE_MAX_CHARS;

const PROPOSE_SYSTEM = [
  "You maintain a small memory of one person for an assistant that helps them.",
  "Read the sessions and propose the few observations genuinely worth carrying into future sessions.",
  "A good note is specific, durable, and useful later: a preference, a recurring constraint, a decision with its reason, a fact about how they work.",
  "Do not restate what a single message said in passing. Do not write summaries of the sessions. Do not write anything the sessions do not support.",
  "Fewer is better: two strong notes beat eight weak ones, and zero is a valid answer.",
  `Each note is one sentence under ${NOTE_MAX} characters.`,
  'Return only JSON: {"notes":[{"body":string,"quote":string}]}. "quote" is the exact words from the sessions the note rests on.',
].join("\n");

const CHECK_SYSTEM = [
  "You audit an assistant's remembered notes against the sessions they came from.",
  "For each note say one of:",
  '  "keep"      the sessions support it as written.',
  '  "correct"   the sessions contradict part of it; give the corrected one-sentence note.',
  '  "drop"      the sessions contradict it and no correction is supported.',
  '  "unknown"   the sessions say nothing either way; leave it alone.',
  "Be conservative: correct only what the sessions actually show to be wrong.",
  'Also name duplicates: two notes that say the same thing are one note. In "duplicates" give the id of the note to keep and the id of the one to fold into it. Keep the earlier, shorter statement of the same fact.',
  'Return only JSON: {"verdicts":[{"id":string,"verdict":"keep"|"correct"|"drop"|"unknown","body"?:string}],"duplicates":[{"keepId":string,"dropId":string}]}.',
].join("\n");

/** A parsed note proposal or a named reason there is none. */
type ModelNotes =
  | { kind: "notes"; notes: { body: string; quote: string | null }[] }
  | { kind: "refused" }
  | { kind: "empty" }
  | { kind: "invalid" };

/** The checker's report: a verdict per note, plus the duplicate pairs it found. */
type ModelVerdicts =
  | {
      kind: "verdicts";
      verdicts: { id: string; verdict: "keep" | "correct" | "drop" | "unknown"; body?: string }[];
      duplicates: { keepId: string; dropId: string }[];
    }
  | { kind: "refused" }
  | { kind: "empty" }
  | { kind: "invalid" };

function stripFence(raw: string): string {
  return raw.replace(/```(?:json)?/gi, "").trim();
}

/**
 * The defensive parse of a note proposal. An empty reply is `empty`; a reply
 * that is not the JSON object asked for is `invalid`; both are distinct from
 * a refusal, which the caller detects before parsing.
 */
function parseNoteProposals(raw: string): ModelNotes {
  const text = stripFence(raw);
  if (text === "") return { kind: "empty" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { kind: "invalid" };
  }
  const list = (parsed as { notes?: unknown } | null)?.notes;
  if (!Array.isArray(list)) return { kind: "invalid" };
  const notes: { body: string; quote: string | null }[] = [];
  for (const entry of list) {
    const record = entry as { body?: unknown; quote?: unknown } | null;
    if (typeof record?.body !== "string" || record.body.trim() === "") continue;
    notes.push({
      body: record.body.trim().slice(0, NOTE_MAX),
      quote: typeof record.quote === "string" && record.quote.trim() ? record.quote.trim().slice(0, 500) : null,
    });
  }
  if (notes.length === 0) return { kind: "empty" };
  return { kind: "notes", notes: notes.slice(0, MAX_PROPOSED) };
}

const VERDICTS = new Set(["keep", "correct", "drop", "unknown"]);

function parseNoteVerdicts(raw: string): ModelVerdicts {
  const text = stripFence(raw);
  if (text === "") return { kind: "empty" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { kind: "invalid" };
  }
  const list = (parsed as { verdicts?: unknown } | null)?.verdicts;
  if (!Array.isArray(list)) return { kind: "invalid" };
  const verdicts: { id: string; verdict: "keep" | "correct" | "drop" | "unknown"; body?: string }[] = [];
  for (const entry of list) {
    const record = entry as { id?: unknown; verdict?: unknown; body?: unknown } | null;
    if (typeof record?.id !== "string" || typeof record.verdict !== "string" || !VERDICTS.has(record.verdict)) continue;
    verdicts.push({
      id: record.id,
      verdict: record.verdict as "keep" | "correct" | "drop" | "unknown",
      ...(typeof record.body === "string" && record.body.trim() ? { body: record.body.trim().slice(0, NOTE_MAX) } : {}),
    });
  }
  const duplicateList = (parsed as { duplicates?: unknown } | null)?.duplicates;
  const duplicates: { keepId: string; dropId: string }[] = [];
  if (Array.isArray(duplicateList)) {
    for (const entry of duplicateList) {
      const record = entry as { keepId?: unknown; dropId?: unknown } | null;
      if (typeof record?.keepId !== "string" || typeof record?.dropId !== "string") continue;
      duplicates.push({ keepId: record.keepId, dropId: record.dropId });
    }
  }
  if (verdicts.length === 0 && duplicates.length === 0) return { kind: "empty" };
  return { kind: "verdicts", verdicts, duplicates };
}

/**
 * The pure half of consolidation, so its rules are testable without a model
 * or a database: given proposals, existing notes, and verdicts, say what to
 * write, what to correct, what to drop, and which duplicates to fold.
 *
 * Order matters and is deliberate:
 *   - an existing note the checker contradicts is corrected or dropped FIRST,
 *     so a proposed duplicate of a corrected note collides on the corrected
 *     text rather than resurrecting the wrong wording;
 *   - proposals are deduped against existing bodies by normalized key, and
 *     among themselves;
 *   - duplicates are the same key, or a verdict of `drop` on an existing note
 *     whose proposal restates it (the model's restatement finding).
 */
export type ExistingNote = { id: string; body: string };

export type ConsolidationPlan = {
  create: { body: string; quote: string | null }[];
  correct: { id: string; body: string }[];
  drop: string[];
  mergeInto: { keepId: string; dropIds: string[] }[];
};

export function planConsolidation(input: {
  proposals: { body: string; quote: string | null }[];
  existing: ExistingNote[];
  verdicts: { id: string; verdict: "keep" | "correct" | "drop" | "unknown"; body?: string }[];
  /** Restatements the model named: one existing note restated by another. */
  restatements?: { keepId: string; dropId: string }[];
}): ConsolidationPlan {
  const byId = new Map(input.existing.map((note) => [note.id, note]));
  const correct: { id: string; body: string }[] = [];
  const drop: string[] = [];
  const correctedKeys = new Map<string, string>(); // note id -> new key

  for (const verdict of input.verdicts) {
    const note = byId.get(verdict.id);
    if (!note) continue;
    if (verdict.verdict === "correct" && verdict.body && verdict.body.trim()) {
      const body = verdict.body.trim().slice(0, NOTE_MAX);
      if (memoryNoteKey(body) === memoryNoteKey(note.body)) continue; // no-op correction
      correct.push({ id: note.id, body });
      correctedKeys.set(note.id, memoryNoteKey(body));
    } else if (verdict.verdict === "drop") {
      drop.push(note.id);
    }
  }

  // Existing keys after corrections, so a proposal that restates the corrected
  // wording is not written a second time.
  const takenKeys = new Set(
    input.existing
      .filter((note) => !drop.includes(note.id))
      .map((note) => correctedKeys.get(note.id) ?? memoryNoteKey(note.body)),
  );

  const create: { body: string; quote: string | null }[] = [];
  for (const proposal of input.proposals) {
    const key = memoryNoteKey(proposal.body);
    if (!key || takenKeys.has(key)) continue;
    takenKeys.add(key);
    create.push(proposal);
  }

  // Restatements: fold the later duplicate into the kept note. A drop already
  // planned is not merged again.
  const mergeInto: ConsolidationPlan["mergeInto"] = [];
  const seenKeep = new Map<string, string[]>();
  for (const pair of input.restatements ?? []) {
    if (!byId.has(pair.keepId) || !byId.has(pair.dropId)) continue;
    if (drop.includes(pair.dropId) || pair.keepId === pair.dropId) continue;
    seenKeep.set(pair.keepId, [...(seenKeep.get(pair.keepId) ?? []), pair.dropId]);
  }
  for (const [keepId, dropIds] of seenKeep) {
    mergeInto.push({ keepId, dropIds: dropIds.filter((id) => !drop.includes(id)) });
  }

  return { create, correct, drop, mergeInto };
}

/** True when two notes say the same thing after normalization. Duplicate detection's one rule. */
export function isDuplicateNote(a: string, b: string): boolean {
  return normalizeMemoryBody(a) !== "" && memoryNoteKey(a) === memoryNoteKey(b);
}

export type DreamSummary = {
  transcripts: number;
  proposed: number;
  created: number;
  corrected: number;
  dropped: number;
  merged: number;
  /** Notes the index cannot show inside its cap. Demoted, not truncated. */
  heldBack: number;
  model: { propose: ModelNotes["kind"] | "skipped"; check: ModelVerdicts["kind"] | "skipped" };
};

type DreamDeps = {
  model?: ReturnType<typeof chatModel>;
  /** The injected-index builder, injected so the summary can report the cap's effect. */
  indexOf?: (owner: { workspaceId: string; userId: string }) => Promise<{ heldBack: number }>;
};

/** One run's transcript, as text. Machine events are skipped: they are not what the person said. */
async function transcriptText(runId: string, workspaceId: string): Promise<string> {
  const events = await db
    .select({ type: runEvents.type, data: runEvents.data })
    .from(runEvents)
    .where(and(eq(runEvents.runId, runId), eq(runEvents.workspaceId, workspaceId)))
    .orderBy(asc(runEvents.sequence))
    .limit(200);
  const lines: string[] = [];
  for (const event of events) {
    const data = (event.data ?? {}) as { role?: unknown; content?: unknown; message?: unknown };
    if (event.type === "message" && typeof data.content === "string") {
      lines.push(`${data.role === "assistant" ? "assistant" : "user"}: ${data.content}`);
    } else if (event.type === "message.completed" && typeof data.message === "string") {
      lines.push(`assistant: ${data.message}`);
    }
  }
  return lines.join("\n").slice(0, MAX_TRANSCRIPT_CHARS);
}

/**
 * One dreaming pass for one owner. Idempotent: the watermark is the newest
 * run it consumed, and a second call with no newer runs returns without a
 * model call.
 */
export async function runDreamPass(auth: AuthContext, deps: DreamDeps = {}): Promise<DreamSummary> {
  const owner = { workspaceId: auth.workspaceId, userId: auth.userId };
  const summary: DreamSummary = {
    transcripts: 0,
    proposed: 0,
    created: 0,
    corrected: 0,
    dropped: 0,
    merged: 0,
    heldBack: 0,
    model: { propose: "skipped", check: "skipped" },
  };

  // Only the EXISTENCE of a watermark is read in JS. The comparison itself
  // stays in SQL: timestamptz keeps microseconds and a JS Date keeps
  // milliseconds, so a watermark round-tripped through JS reads back
  // *earlier* than the run it names, and that run would be re-read (and
  // re-billed) forever.
  const [dream] = await db
    .select({ id: memoryDreams.id })
    .from(memoryDreams)
    .where(and(eq(memoryDreams.workspaceId, auth.workspaceId), eq(memoryDreams.userId, auth.userId)))
    .limit(1);

  const runs = await db
    .select({ id: agentRuns.id, createdAt: agentRuns.createdAt })
    .from(agentRuns)
    .where(
      and(
        eq(agentRuns.workspaceId, auth.workspaceId),
        eq(agentRuns.createdBy, auth.userId),
        inArray(agentRuns.state, ["succeeded", "failed", "cancelled"]),
        isNull(agentRuns.discardedAt),
        isNotNull(agentRuns.endedAt),
        ...(dream
          ? [
              sql`${agentRuns.createdAt} > (select checked_through from memory_dreams
                    where workspace_id = ${auth.workspaceId} and user_id = ${auth.userId}
                      and checked_through is not null)`,
            ]
          : []),
      ),
    )
    .orderBy(desc(agentRuns.createdAt))
    .limit(MAX_TRANSCRIPTS);
  if (runs.length === 0) return summary;
  summary.transcripts = runs.length;

  const transcripts: { runId: string; text: string }[] = [];
  for (const run of runs) {
    const text = await transcriptText(run.id, auth.workspaceId);
    if (text.trim()) transcripts.push({ runId: run.id, text });
  }

  const existing = await db
    .select({ id: memoryNotes.id, body: memoryNotes.body })
    .from(memoryNotes)
    .where(
      and(
        eq(memoryNotes.workspaceId, auth.workspaceId),
        eq(memoryNotes.userId, auth.userId),
        isNull(memoryNotes.archivedAt),
      ),
    )
    .orderBy(asc(memoryNotes.createdAt))
    .limit(MAX_EXISTING_CHECKED);

  if (transcripts.length === 0) {
    // Transcripts exist but held no words (all machinery): advance the
    // watermark so the next pass does not re-read them, and write nothing.
    await advanceDream(auth, runs[0].id, summary);
    return summary;
  }

  let proposals: { body: string; quote: string | null }[] = [];
  let verdicts: { id: string; verdict: "keep" | "correct" | "drop" | "unknown"; body?: string }[] = [];
  let duplicates: { keepId: string; dropId: string }[] = [];

  const option = modelById(DEFAULT_MODEL_ID);
  if (!option && !deps.model) throw new Error(`${MEMORY_DREAM_TOPIC}: the default model is no longer in the catalog`);
  const model = deps.model ?? chatModel(option!);
  const corpus = transcripts.map((t) => `<<<SESSION ${t.runId}>>>\n${t.text}\n<<<END SESSION>>>`).join("\n\n");

  const propose = await generateText({
    model,
    system: PROPOSE_SYSTEM,
    prompt: corpus,
    maxOutputTokens: 2_000,
  });
  if (propose.finishReason === "content-filter") {
    summary.model.propose = "refused";
  } else {
    const parsed = parseNoteProposals(propose.text);
    summary.model.propose = parsed.kind;
    if (parsed.kind === "notes") {
      proposals = parsed.notes.slice(0, MAX_PROPOSED);
      summary.proposed = proposals.length;
    }
  }

  if (existing.length > 0) {
    const check = await generateText({
      model,
      system: CHECK_SYSTEM,
      prompt: [
        "NOTES (each id is the note's identity):",
        ...existing.map((note) => `<note id="${note.id}">${note.body}</note>`),
        "",
        "SESSIONS:",
        corpus,
      ].join("\n"),
      maxOutputTokens: 2_000,
    });
    if (check.finishReason === "content-filter") {
      summary.model.check = "refused";
    } else {
      const parsed = parseNoteVerdicts(check.text);
      summary.model.check = parsed.kind;
      if (parsed.kind === "verdicts") {
        verdicts = parsed.verdicts;
        duplicates = parsed.duplicates;
      }
    }
  }

  // A proposal whose body equals an existing note collides on the normalized
  // key, so planConsolidation skips it: the row is not written twice. Notes the
  // checker names as restatements of each other are folded, gaining the pass a
  // merge instead of two rows that say the same thing.
  const plan = planConsolidation({ proposals, existing, verdicts, restatements: duplicates });

  for (const correction of plan.correct) {
    if ((await correctMemoryNote(owner, { noteId: correction.id, body: correction.body })).corrected) {
      summary.corrected += 1;
    }
  }
  if (plan.drop.length > 0) {
    const dropped = await db
      .update(memoryNotes)
      .set({ archivedAt: sql`now()`, updatedAt: sql`now()`, version: sql`${memoryNotes.version} + 1` })
      .where(
        and(
          eq(memoryNotes.workspaceId, auth.workspaceId),
          eq(memoryNotes.userId, auth.userId),
          inArray(memoryNotes.id, plan.drop),
        ),
      )
      .returning({ id: memoryNotes.id });
    summary.dropped = dropped.length;
  }
  for (const merge of plan.mergeInto) {
    const { merged } = await mergeMemoryNotes(owner, { keepId: merge.keepId, dropIds: merge.dropIds });
    summary.merged += merged;
  }
  for (const note of plan.create) {
    const written = await upsertMemoryNote(
      { ...owner, createdBy: auth.userId },
      {
        body: note.body,
        sourceKind: "run",
        sourceId: transcripts[0]?.runId ?? null,
        sourceQuote: note.quote,
        status: "unconfirmed",
      },
    );
    if (written.created) summary.created += 1;
  }

  if (deps.indexOf) summary.heldBack = (await deps.indexOf(owner)).heldBack;
  await advanceDream(auth, runs[0].id, summary);
  return summary;
}

/**
 * Records the watermark and the pass's report in one row per owner.
 *
 * The watermark is read from the run row IN SQL, not from the Date this
 * process already held: a JS Date keeps milliseconds and the column keeps
 * microseconds, so writing the truncated value left the run the pass just
 * consumed still "newer" than the watermark — a second pass would re-read and
 * re-bill it. Reading `created_at` back out of the same row keeps the two
 * values identical.
 */
async function advanceDream(auth: AuthContext, newestRunId: string, summary: DreamSummary): Promise<void> {
  const checkedThrough = sql`(select created_at from agent_runs where id = ${newestRunId} and workspace_id = ${auth.workspaceId})`;
  await withTransaction(async (tx) => {
    const [updated] = await tx
      .update(memoryDreams)
      .set({ checkedThrough, lastSummary: summary, updatedAt: sql`now()`, version: sql`${memoryDreams.version} + 1` })
      .where(and(eq(memoryDreams.workspaceId, auth.workspaceId), eq(memoryDreams.userId, auth.userId)))
      .returning({ id: memoryDreams.id });
    if (updated) return;
    await tx
      .insert(memoryDreams)
      .values({
        workspaceId: auth.workspaceId,
        userId: auth.userId,
        checkedThrough,
        lastSummary: summary,
        createdBy: auth.userId,
        updatedBy: auth.userId,
      })
      .onConflictDoNothing({ target: [memoryDreams.workspaceId, memoryDreams.userId] });
  });
}

/** The last pass's report for an owner, for the owner-facing surface. */
export async function lastDreamSummary(auth: AuthContext): Promise<DreamSummary | null> {
  const [row] = await db
    .select({ summary: memoryDreams.lastSummary, checkedThrough: memoryDreams.checkedThrough })
    .from(memoryDreams)
    .where(and(eq(memoryDreams.workspaceId, auth.workspaceId), eq(memoryDreams.userId, auth.userId)))
    .limit(1);
  return row ? ({ ...(row.summary as DreamSummary), checkedThrough: row.checkedThrough } as DreamSummary) : null;
}

/** The outbox consumer: one pass as the workspace owner who is named in the payload. */
export function memoryDreamRequestedHandler(
  ownerAuth: (workspaceId: string) => Promise<AuthContext | null>,
): OutboxHandler {
  return async (event: ClaimedOutboxEvent) => {
    const payload = (event.payload ?? {}) as { userId?: unknown };
    const auth = await ownerAuth(event.workspaceId);
    if (!auth) return;
    const userId = typeof payload.userId === "string" ? payload.userId : auth.userId;
    await runDreamPass({ ...auth, userId });
  };
}
