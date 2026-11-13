import { and, asc, desc, eq, sql } from "drizzle-orm";
import { recordAudit } from "@/domains/audit/record";
import type { AuthContext } from "@/domains/identity/resolve";
import { db } from "@/lib/db";
import { withTransaction } from "@/lib/db-transaction";
import {
  CHALLENGE_PROMPT_VERSION,
  defaultExplainItGenerator,
  type ExplainItGenerator,
  type ExplainSource,
  type ProposedChallenge,
} from "@/integrations/learning/explain-it";
import {
  challengeContentSchema,
  challengeSteps,
  type ChallengeContent,
  type ChallengeFormat,
} from "./challenge-content";
import { gradeByRules, isIndependent, type ChallengeGrade, type RuleGrade } from "./challenge-grading";
import { loadPinnedExplainSources, verifyEvidence } from "./explain-it";
import { loadCurrentQuizSources, QuizGenerationError } from "./generate-quiz";
import {
  learningChallengeAttempts,
  learningChallenges,
  type ExplainEvidence,
  type ExplainSourceSnapshot,
} from "./schema";

/*
 * Practice challenges: Predict and Bug Hunt. A challenge is pinned to exact
 * source versions, made off the request, stored whole, and from then on read
 * only from what was stored. The learner commits an answer before anything is
 * revealed; the rules in `challenge-grading.ts` grade it, and the Explain It
 * evaluator is asked only when the rules cannot decide.
 */

export class ChallengeError extends Error {
  constructor(
    public readonly code:
      "invalid_sources" | "source_not_ready" | "not_found" | "not_ready" | "empty_answer" | "already_submitted",
    message: string,
  ) {
    super(message);
    this.name = "ChallengeError";
  }
}

/** A challenge still `preparing` after this long was abandoned by a run that died. */
const PREPARING_TIMEOUT_MS = 3 * 60_000;
const MAX_ANSWER_CHARS = 5000;

/** Why a model-written challenge was turned down. */
export type ChallengeRejection =
  | "unreadable"
  | "wrong_format"
  | "evidence_unverified"
  | "answer_fails_own_check"
  | "question_gives_answer"
  | "hint_gives_answer"
  | "accept_and_reject_overlap";

const REJECTION_MESSAGE = "This source did not give a clear enough rule to build an exercise on. Try another source.";

/** The text a learner sees before answering. */
function promptText(content: ChallengeContent): string {
  const body =
    content.format === "predict"
      ? content.situation
      : content.artifact.lines.map((line, index) => `${index + 1}  ${line}`).join("\n");
  return `${body}\n\n${content.question}`;
}

/**
 * The trust boundary for a model-written challenge. Pure: it parses the
 * content, locates the evidence in the pinned source text, and proves the
 * checks are sound against the challenge's own text. A model answer that fails
 * its own check, or a question that already passes it, means the check cannot
 * be trusted to grade a learner.
 */
export function acceptProposedChallenge(
  format: ChallengeFormat,
  proposed: ProposedChallenge,
  sources: Array<ExplainSource & ExplainSourceSnapshot>,
): { ok: true; content: ChallengeContent; evidence: ExplainEvidence[] } | { ok: false; reason: ChallengeRejection } {
  const parsed = challengeContentSchema.safeParse(proposed.content);
  if (!parsed.success) return { ok: false, reason: "unreadable" };
  const content = parsed.data;
  if (content.format !== format) return { ok: false, reason: "wrong_format" };
  const evidence = verifyEvidence(sources, proposed.evidence);
  if (evidence.length === 0) return { ok: false, reason: "evidence_unverified" };

  const steps = challengeSteps(content);
  const phrases = (pick: "accept" | "reject") =>
    steps.flatMap((step) => (step.check.kind === "terms" ? step.check[pick].flat() : [])).map((p) => p.toLowerCase());
  const accepted = new Set(phrases("accept"));
  if (phrases("reject").some((phrase) => accepted.has(phrase)))
    return { ok: false, reason: "accept_and_reject_overlap" };
  if (gradeByRules(steps, content.answer).grade !== "correct") return { ok: false, reason: "answer_fails_own_check" };
  if (gradeByRules(steps, promptText(content)).grade === "correct")
    return { ok: false, reason: "question_gives_answer" };
  if (gradeByRules(steps, content.hints[0]).grade === "correct") return { ok: false, reason: "hint_gives_answer" };
  return { ok: true, content, evidence };
}

export async function startChallenge(
  auth: AuthContext,
  input: { notebookId: string; documentIds: string[]; format: ChallengeFormat; idempotencyKey: string },
): Promise<{ challengeId: string; created: boolean }> {
  let sources;
  try {
    sources = await loadCurrentQuizSources(auth, input.documentIds);
  } catch (cause) {
    if (cause instanceof QuizGenerationError && cause.code === "no_extraction") {
      throw new ChallengeError("source_not_ready", "Every source must finish reading before you can practice on it.");
    }
    throw new ChallengeError("invalid_sources", "One or more sources are unavailable in this workspace.");
  }
  const manifest: ExplainSourceSnapshot[] = sources.map(({ documentId, extractionId, title }) => ({
    documentId,
    extractionId,
    title,
  }));
  return withTransaction(async (tx) => {
    const [created] = await tx
      .insert(learningChallenges)
      .values({
        workspaceId: auth.workspaceId,
        notebookId: input.notebookId,
        userId: auth.userId,
        format: input.format,
        sourceManifest: manifest,
        generationKey: input.idempotencyKey,
        createdBy: auth.userId,
        updatedBy: auth.userId,
      })
      .onConflictDoNothing()
      .returning({ id: learningChallenges.id });
    if (!created) {
      const [prior] = await tx
        .select({
          id: learningChallenges.id,
          notebookId: learningChallenges.notebookId,
          format: learningChallenges.format,
        })
        .from(learningChallenges)
        .where(
          and(
            eq(learningChallenges.workspaceId, auth.workspaceId),
            eq(learningChallenges.userId, auth.userId),
            eq(learningChallenges.generationKey, input.idempotencyKey),
          ),
        )
        .limit(1);
      if (!prior || prior.notebookId !== input.notebookId || prior.format !== input.format) {
        throw new ChallengeError("invalid_sources", "This request key already belongs to a different exercise.");
      }
      return { challengeId: prior.id, created: false };
    }
    await recordAudit(
      auth,
      {
        action: "learning.challenge_started",
        subjectType: "learning_challenge",
        subjectId: created.id,
        summary: "Started a practice exercise",
        metadata: { format: input.format, sourceCount: manifest.length, promptVersion: CHALLENGE_PROMPT_VERSION },
      },
      tx,
    );
    return { challengeId: created.id, created: true };
  });
}

/**
 * Writes the challenge. Runs after the request that started it has returned.
 * Only a `preparing` row is written to, so a second run of the same challenge
 * changes nothing.
 */
export async function prepareChallenge(
  auth: AuthContext,
  challengeId: string,
  generator?: ExplainItGenerator,
): Promise<void> {
  const [row] = await db
    .select({
      id: learningChallenges.id,
      format: learningChallenges.format,
      status: learningChallenges.status,
      sourceManifest: learningChallenges.sourceManifest,
    })
    .from(learningChallenges)
    .where(
      and(
        eq(learningChallenges.id, challengeId),
        eq(learningChallenges.workspaceId, auth.workspaceId),
        eq(learningChallenges.userId, auth.userId),
      ),
    )
    .limit(1);
  if (!row || row.status !== "preparing") return;

  const settle = (
    values:
      { status: "ready"; content: ChallengeContent; evidence: ExplainEvidence[] } | { status: "failed"; error: string },
  ) =>
    db
      .update(learningChallenges)
      .set({
        ...values,
        ...(values.status === "ready" ? { objective: values.content.objective } : {}),
        promptVersion: CHALLENGE_PROMPT_VERSION,
        updatedBy: auth.userId,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(learningChallenges.id, row.id),
          eq(learningChallenges.workspaceId, auth.workspaceId),
          eq(learningChallenges.status, "preparing"),
        ),
      );

  let outcome: ReturnType<typeof acceptProposedChallenge>;
  try {
    const sources = await loadPinnedExplainSources(auth, row.sourceManifest);
    const engine = generator ?? (await defaultExplainItGenerator(auth.workspaceId));
    const proposed = await engine.challenge(
      row.format,
      sources.map(({ title, text }) => ({ title, text })),
    );
    outcome = acceptProposedChallenge(row.format, proposed, sources);
  } catch {
    await settle({ status: "failed", error: "The exercise could not be made just now. Try again." });
    return;
  }
  await settle(
    outcome.ok
      ? { status: "ready", content: outcome.content, evidence: outcome.evidence }
      : { status: "failed", error: REJECTION_MESSAGE },
  );
}

type AttemptRow = typeof learningChallengeAttempts.$inferSelect;

export type ChallengeAttemptView = {
  id: string;
  ordinal: number;
  answer: string;
  dontKnow: boolean;
  hintsUsed: number;
  grade: ChallengeGrade | null;
  /** The step feedback names, in the learner's words: "why it happens". */
  failedStep: string | null;
  feedback: string;
  evidence: ExplainEvidence[];
  /** Right on the first try with no hint: the only attempts that show unaided ability. */
  independent: boolean;
  createdAt: Date;
};

export type ChallengeView = {
  id: string;
  format: ChallengeFormat;
  status: "preparing" | "ready" | "failed";
  error: string | null;
  /** The sources it is pinned to, by title. */
  title: string;
  objective: string | null;
  createdAt: Date;
  prompt: {
    situation: string | null;
    artifact: { kind: "log" | "code"; lines: string[] } | null;
    question: string;
  } | null;
  /** Hints shown for the answer being written now. */
  hints: string[];
  hintsLeft: number;
  attempts: ChallengeAttemptView[];
  /** The full answer, present only once an answer has been committed. */
  reveal: { answer: string; rule: string; evidence: ExplainEvidence[] } | null;
};

function attemptView(row: AttemptRow, content: ChallengeContent): ChallengeAttemptView {
  const step = challengeSteps(content).find((item) => item.id === row.failedStep);
  return {
    id: row.id,
    ordinal: row.ordinal,
    answer: row.answer,
    dontKnow: row.dontKnow,
    hintsUsed: row.hintsUsed,
    grade: row.grade,
    failedStep: step?.label ?? null,
    feedback: row.feedback,
    evidence: row.evidence,
    independent: isIndependent(row),
    createdAt: row.createdAt,
  };
}

async function loadChallenge(auth: AuthContext, notebookId: string, challengeId: string) {
  const [row] = await db
    .select()
    .from(learningChallenges)
    .where(
      and(
        eq(learningChallenges.id, challengeId),
        eq(learningChallenges.workspaceId, auth.workspaceId),
        eq(learningChallenges.notebookId, notebookId),
        eq(learningChallenges.userId, auth.userId),
      ),
    )
    .limit(1);
  return row ?? null;
}

function loadAttempts(auth: AuthContext, challengeId: string) {
  return db
    .select()
    .from(learningChallengeAttempts)
    .where(
      and(
        eq(learningChallengeAttempts.workspaceId, auth.workspaceId),
        eq(learningChallengeAttempts.challengeId, challengeId),
        eq(learningChallengeAttempts.userId, auth.userId),
      ),
    )
    .orderBy(asc(learningChallengeAttempts.ordinal));
}

function readStatus(row: { status: ChallengeView["status"]; createdAt: Date; error: string | null }) {
  if (row.status === "preparing" && Date.now() - row.createdAt.getTime() > PREPARING_TIMEOUT_MS) {
    return { status: "failed" as const, error: "The exercise could not be made just now. Try again." };
  }
  return { status: row.status, error: row.error };
}

/** One challenge with its attempts, read from stored content only. */
export async function getChallenge(
  auth: AuthContext,
  notebookId: string,
  challengeId: string,
): Promise<ChallengeView | null> {
  const row = await loadChallenge(auth, notebookId, challengeId);
  if (!row) return null;
  const content = row.status === "ready" ? row.content : null;
  const attempts = content ? await loadAttempts(auth, row.id) : [];
  return {
    id: row.id,
    format: row.format,
    ...readStatus(row),
    title: row.sourceManifest.map((source) => source.title).join(" + "),
    objective: row.objective,
    createdAt: row.createdAt,
    prompt: content && {
      situation: content.format === "predict" ? content.situation : null,
      artifact: content.format === "bug_hunt" ? content.artifact : null,
      question: content.question,
    },
    hints: content ? content.hints.slice(0, row.hintsShown) : [],
    hintsLeft: content ? content.hints.length - row.hintsShown : 0,
    attempts: content ? attempts.map((attempt) => attemptView(attempt, content)) : [],
    reveal:
      content && attempts.length > 0 ? { answer: content.answer, rule: content.rule, evidence: row.evidence } : null,
  };
}

export type ChallengeSummary = {
  id: string;
  format: ChallengeFormat;
  status: ChallengeView["status"];
  error: string | null;
  objective: string | null;
  createdAt: Date;
  attemptCount: number;
};

/** The learner's newest challenges in one notebook. */
export async function listChallenges(auth: AuthContext, notebookId: string): Promise<ChallengeSummary[]> {
  const rows = await db
    .select({
      id: learningChallenges.id,
      format: learningChallenges.format,
      status: learningChallenges.status,
      error: learningChallenges.error,
      objective: learningChallenges.objective,
      createdAt: learningChallenges.createdAt,
      // Table names are spelled out: inside a single-table select drizzle
      // renders columns bare, which would compare the attempt to itself.
      attemptCount: sql<number>`(select count(*)::int from learning_challenge_attempts a where a.challenge_id = learning_challenges.id)`,
    })
    .from(learningChallenges)
    .where(
      and(
        eq(learningChallenges.workspaceId, auth.workspaceId),
        eq(learningChallenges.notebookId, notebookId),
        eq(learningChallenges.userId, auth.userId),
      ),
    )
    .orderBy(desc(learningChallenges.createdAt), desc(learningChallenges.id))
    .limit(8);
  return rows.map((row) => ({ ...row, ...readStatus(row) }));
}

/** Shows the next hint. The answer being written is assisted from here on. */
export async function showChallengeHint(
  auth: AuthContext,
  input: { notebookId: string; challengeId: string },
): Promise<void> {
  const row = await loadChallenge(auth, input.notebookId, input.challengeId);
  if (!row) throw new ChallengeError("not_found", "That exercise is not available.");
  if (row.status !== "ready" || !row.content) throw new ChallengeError("not_ready", "That exercise is not ready.");
  await db
    .update(learningChallenges)
    .set({ hintsShown: sql`${learningChallenges.hintsShown} + 1`, updatedBy: auth.userId, updatedAt: new Date() })
    .where(
      and(
        eq(learningChallenges.id, row.id),
        eq(learningChallenges.workspaceId, auth.workspaceId),
        sql`${learningChallenges.hintsShown} < ${row.content.hints.length}`,
      ),
    );
}

type Verdict = {
  grade: ChallengeGrade | null;
  failedStep: string | null;
  feedback: string;
  gradedBy: "rules" | "model";
  evidence: ExplainEvidence[];
};

function rulesFeedback(rules: RuleGrade, content: ChallengeContent): string {
  if (rules.grade === "correct") return `You got both parts: ${rules.steps.map((s) => s.label).join(" and ")}.`;
  const met = rules.steps.filter((step) => step.verdict === "met").map((step) => step.label);
  const lead = met.length > 0 ? `You got ${met.join(" and ")}. ` : "";
  return `${lead}What is off is ${rules.failedStep!.label}. ${content.rule}`;
}

const UNCHECKED_FEEDBACK =
  "This answer could not be checked with confidence against the source. Compare it with the answer below.";

/** What the Explain It evaluator is asked: the challenge as the learner saw it, plus the stored answer to compare with. */
export function evaluatorQuestion(content: ChallengeContent): string {
  return `${promptText(content)}\n\nA complete answer, already checked against the sources: ${content.answer}`;
}

/**
 * Who decides. The rules do when they can. When they cannot, the model's
 * opinion counts, and only if it quoted the source exactly (`opinion` is null
 * otherwise). An answer that says both the right and the wrong thing stays
 * uncertain whatever the model says.
 */
export function combineVerdict(
  rules: RuleGrade,
  opinion: { grade: ChallengeGrade } | null,
): { grade: ChallengeGrade; gradedBy: "rules" | "model" } {
  if (rules.grade !== "uncertain" || !opinion) return { grade: rules.grade, gradedBy: "rules" };
  return { grade: rules.conflicted ? "uncertain" : opinion.grade, gradedBy: "model" };
}

async function decide(
  auth: AuthContext,
  row: { sourceManifest: ExplainSourceSnapshot[]; evidence: ExplainEvidence[] },
  content: ChallengeContent,
  answer: string,
  generator?: ExplainItGenerator,
): Promise<Verdict> {
  const rules = gradeByRules(challengeSteps(content), answer);
  let opinion: { grade: ChallengeGrade; feedback: string; evidence: ExplainEvidence[] } | null = null;
  if (rules.grade === "uncertain") {
    try {
      const sources = await loadPinnedExplainSources(auth, row.sourceManifest);
      const engine = generator ?? (await defaultExplainItGenerator(auth.workspaceId));
      const evaluation = await engine.evaluate({
        sources: sources.map(({ title, text }) => ({ title, text })),
        question: evaluatorQuestion(content),
        answer,
        history: [],
      });
      const evidence = verifyEvidence(sources, evaluation.evidence);
      if (evidence.length > 0) {
        opinion = { grade: evaluation.grade, feedback: evaluation.feedback.trim().slice(0, 1200), evidence };
      }
    } catch {
      // No opinion: the attempt is stored as uncertain rather than lost.
    }
  }
  const { grade, gradedBy } = combineVerdict(rules, opinion);
  return {
    grade,
    failedStep: grade === "correct" ? null : (rules.failedStep?.id ?? null),
    feedback:
      gradedBy === "model"
        ? opinion!.feedback
        : rules.grade === "uncertain"
          ? UNCHECKED_FEEDBACK
          : rulesFeedback(rules, content),
    gradedBy,
    evidence: gradedBy === "model" ? opinion!.evidence : row.evidence,
  };
}

/**
 * Commits one answer and returns its stored attempt. The same `submitKey`
 * always returns the first attempt it wrote, so a retried request neither
 * grades twice nor adds a row.
 */
export async function submitChallengeAttempt(
  auth: AuthContext,
  input: { notebookId: string; challengeId: string; submitKey: string; answer: string; dontKnow: boolean },
  generator?: ExplainItGenerator,
): Promise<{ attemptId: string; replayed: boolean }> {
  const row = await loadChallenge(auth, input.notebookId, input.challengeId);
  if (!row) throw new ChallengeError("not_found", "That exercise is not available.");
  const findReplay = async () => {
    const [prior] = await db
      .select({ id: learningChallengeAttempts.id, challengeId: learningChallengeAttempts.challengeId })
      .from(learningChallengeAttempts)
      .where(
        and(
          eq(learningChallengeAttempts.workspaceId, auth.workspaceId),
          eq(learningChallengeAttempts.userId, auth.userId),
          eq(learningChallengeAttempts.submitKey, input.submitKey),
        ),
      )
      .limit(1);
    if (prior && prior.challengeId !== row.id) {
      throw new ChallengeError("already_submitted", "This request key belongs to a different exercise.");
    }
    return prior ?? null;
  };
  const replay = await findReplay();
  if (replay) return { attemptId: replay.id, replayed: true };

  const content = row.status === "ready" ? row.content : null;
  if (!content) throw new ChallengeError("not_ready", "That exercise is not ready.");
  const answer = input.dontKnow ? "" : input.answer.trim().slice(0, MAX_ANSWER_CHARS);
  if (!input.dontKnow && !answer) throw new ChallengeError("empty_answer", "Write an answer first.");

  const verdict: Verdict = input.dontKnow
    ? {
        grade: null,
        failedStep: null,
        feedback: "No guess taken. Read the answer below, then try it again later.",
        gradedBy: "rules",
        evidence: row.evidence,
      }
    : await decide(auth, row, content, answer, generator);

  try {
    return await withTransaction(async (tx) => {
      // The hint count is read under the row lock, so a hint shown while the
      // answer was being graded still marks this attempt as assisted.
      const [locked] = await tx
        .select({ hintsShown: learningChallenges.hintsShown })
        .from(learningChallenges)
        .where(and(eq(learningChallenges.id, row.id), eq(learningChallenges.workspaceId, auth.workspaceId)))
        .for("update");
      const [{ ordinal }] = await tx
        .select({ ordinal: sql<number>`count(*)::int` })
        .from(learningChallengeAttempts)
        .where(eq(learningChallengeAttempts.challengeId, row.id));
      const [attempt] = await tx
        .insert(learningChallengeAttempts)
        .values({
          workspaceId: auth.workspaceId,
          challengeId: row.id,
          userId: auth.userId,
          ordinal,
          submitKey: input.submitKey,
          answer,
          dontKnow: input.dontKnow,
          hintsUsed: locked.hintsShown,
          ...verdict,
        })
        .returning({ id: learningChallengeAttempts.id });
      await tx
        .update(learningChallenges)
        .set({ hintsShown: 0, updatedBy: auth.userId, updatedAt: new Date() })
        .where(and(eq(learningChallenges.id, row.id), eq(learningChallenges.workspaceId, auth.workspaceId)));
      await recordAudit(
        auth,
        {
          action: "learning.challenge_attempted",
          subjectType: "learning_challenge",
          subjectId: row.id,
          summary: "Answered a practice exercise",
          metadata: {
            format: row.format,
            grade: verdict.grade,
            gradedBy: verdict.gradedBy,
            hintsUsed: locked.hintsShown,
            dontKnow: input.dontKnow,
          },
        },
        tx,
      );
      return { attemptId: attempt.id, replayed: false };
    });
  } catch (cause) {
    // Two requests with one key raced: the loser returns the winner's attempt.
    const winner = await findReplay();
    if (winner) return { attemptId: winner.id, replayed: true };
    throw cause;
  }
}
