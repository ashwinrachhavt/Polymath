import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { AuthContext } from "@/domains/identity/resolve";
import { jobViewColumns, retryGenerationJob, submitGenerationJob } from "@/domains/jobs/commands";
import { generationJobs } from "@/domains/jobs/schema";
import { toJobView } from "@/domains/jobs/state";
import { db } from "@/lib/db";
import { EXPLAINER_JOB_KIND, explainerJobKey } from "./job-names";
import { codeExplainers } from "./schema";

/*
 * Explainer requests and the one read model agents poll. The row is created
 * when the request is accepted; the job (kind `understanding.explain`,
 * idempotency key `explainer:<id>`) fills in the note, document and quiz. An
 * explainer is `ready` once its quiz exists, because a note without its check
 * is not yet what was asked for.
 */

/** A sitting passes at four right in five, rounded up. One definition for the answer and the stored check. */
export const PASS_MARK = 0.8;

export type ExplainerView = {
  id: string;
  status: "pending" | "ready" | "failed";
  error: string | null;
  repo: string;
  commit: string;
  range: string | null;
  notePath: string | null;
  quizPath: string | null;
  passed: boolean;
  createdAt: string;
};

const passedSql = sql<boolean>`exists (
  select 1 from quiz_attempts qa
  where qa.quiz_id = code_explainers.quiz_id and qa.user_id = code_explainers.user_id
    and qa.correct_count >= ceil(qa.total_count * ${PASS_MARK}::numeric)
)`;

const viewColumns = {
  id: codeExplainers.id,
  repo: codeExplainers.repo,
  commit: codeExplainers.commitSha,
  range: codeExplainers.range,
  artifactId: codeExplainers.artifactId,
  quizId: codeExplainers.quizId,
  createdAt: codeExplainers.createdAt,
  passed: passedSql.mapWith(Boolean),
};

type Row = {
  id: string;
  repo: string;
  commit: string;
  range: string | null;
  artifactId: string | null;
  quizId: string | null;
  createdAt: Date;
  passed: boolean;
};

async function toViews(auth: Pick<AuthContext, "workspaceId">, rows: Row[]): Promise<ExplainerView[]> {
  const pending = rows.filter((row) => !row.quizId);
  const jobs = pending.length
    ? await db
        .select(jobViewColumns)
        .from(generationJobs)
        .where(
          and(
            eq(generationJobs.workspaceId, auth.workspaceId),
            inArray(
              generationJobs.idempotencyKey,
              pending.map((row) => explainerJobKey(row.id)),
            ),
          ),
        )
    : [];
  const bySubject = new Map(jobs.map((job) => [job.subject, toJobView(job)]));
  return rows.map((row) => {
    const view = bySubject.get(`explainer:${row.id}`);
    const failed = view?.status === "failed";
    return {
      id: row.id,
      status: row.quizId ? "ready" : failed ? "failed" : "pending",
      error: failed ? view.error : null,
      repo: row.repo,
      commit: row.commit,
      range: row.range,
      notePath: row.artifactId ? `/polymath/notes?id=${row.artifactId}` : null,
      quizPath: row.quizId ? `/learn/quizzes/${row.quizId}` : null,
      passed: row.passed,
      createdAt: row.createdAt.toISOString(),
    };
  });
}

export async function getExplainerView(auth: AuthContext, explainerId: string): Promise<ExplainerView | null> {
  const rows = await db.select(viewColumns).from(codeExplainers).where(ownedExplainer(auth, explainerId)).limit(1);
  return (await toViews(auth, rows))[0] ?? null;
}

/** The person's explainers for one commit of one repository, newest first. */
export async function listExplainerViews(
  auth: AuthContext,
  input: { repo: string; commit: string },
): Promise<ExplainerView[]> {
  const rows = await db
    .select(viewColumns)
    .from(codeExplainers)
    .where(
      and(
        eq(codeExplainers.workspaceId, auth.workspaceId),
        eq(codeExplainers.userId, auth.userId),
        eq(codeExplainers.repo, input.repo),
        eq(codeExplainers.commitSha, input.commit),
      ),
    )
    .orderBy(desc(codeExplainers.createdAt), desc(codeExplainers.id));
  return toViews(auth, rows);
}

export function ownedExplainer(auth: Pick<AuthContext, "workspaceId" | "userId">, explainerId: string) {
  return and(
    eq(codeExplainers.id, explainerId),
    eq(codeExplainers.workspaceId, auth.workspaceId),
    eq(codeExplainers.userId, auth.userId),
  );
}

export type ExplainerRequest = {
  repo: string;
  commit: string;
  range: string | null;
  summary: string;
  diff: string;
  requestKey: string;
};

/**
 * Accepts a request to explain a change. `start` names the job attempt the
 * caller should kick after responding, and is null when nothing new was
 * queued: a repeated request key returns the first explainer, and a failed one
 * is retried as a new attempt rather than answered with the old failure.
 */
export async function requestExplainer(
  auth: AuthContext,
  input: ExplainerRequest,
): Promise<{ explainer: ExplainerView; start: { jobId: string; attempt: number } | null }> {
  const [created] = await db
    .insert(codeExplainers)
    .values({
      workspaceId: auth.workspaceId,
      userId: auth.userId,
      requestKey: input.requestKey,
      repo: input.repo,
      commitSha: input.commit,
      range: input.range,
      createdBy: auth.userId,
      updatedBy: auth.userId,
    })
    .onConflictDoNothing({ target: [codeExplainers.workspaceId, codeExplainers.requestKey] })
    .returning({ id: codeExplainers.id });

  if (created) {
    const { job } = await submitGenerationJob(auth, {
      kind: EXPLAINER_JOB_KIND,
      subject: `explainer:${created.id}`,
      idempotencyKey: explainerJobKey(created.id),
      title: `Explainer: ${input.repo} at ${input.commit.slice(0, 7)}`,
      input: { explainerId: created.id, summary: input.summary, diff: input.diff },
    });
    return { explainer: (await getExplainerView(auth, created.id))!, start: { jobId: job.id, attempt: job.attempt } };
  }

  const [existing] = await db
    .select({ id: codeExplainers.id })
    .from(codeExplainers)
    .where(
      and(
        eq(codeExplainers.workspaceId, auth.workspaceId),
        eq(codeExplainers.userId, auth.userId),
        eq(codeExplainers.requestKey, input.requestKey),
      ),
    )
    .limit(1);
  if (!existing) throw new RequestKeyTakenError();
  const view = (await getExplainerView(auth, existing.id))!;
  if (view.status !== "failed") return { explainer: view, start: null };
  const [job] = await db
    .select({ id: generationJobs.id })
    .from(generationJobs)
    .where(
      and(
        eq(generationJobs.workspaceId, auth.workspaceId),
        eq(generationJobs.idempotencyKey, explainerJobKey(existing.id)),
      ),
    )
    .limit(1);
  const retried = job ? await retryGenerationJob(auth, job.id) : null;
  return {
    explainer: (await getExplainerView(auth, existing.id))!,
    start: retried ? { jobId: retried.id, attempt: retried.attempt } : null,
  };
}

export class RequestKeyTakenError extends Error {
  constructor() {
    super("This request key already belongs to another person's explainer.");
    this.name = "RequestKeyTakenError";
  }
}
