import { sql } from "drizzle-orm";
import { check, index, integer, jsonb, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { primaryId, tenantId } from "../../db/columns";
import { users } from "../identity/schema";

/*
 * A generation job is long work a person asked for and does not wait on:
 * making a quiz, reading a site, transcribing a video, writing zettels. The
 * request returns with the job, the work runs later, and every surface reads
 * the job's state from here. The row is the whole truth, so a page opened
 * after the work finished shows the same thing as one that watched it.
 *
 * `status` moves queued -> running -> ready | failed | cancelled, and a
 * failed or cancelled job may be queued again (state.ts). `attempt` counts
 * those retries and fences a run that outlived its retry: only the current
 * attempt may settle the job. `progress` is the run's latest step, which the
 * jobs stream carries to the browser.
 */

export const generationJobStatus = pgEnum("generation_job_status", [
  "queued",
  "running",
  "ready",
  "failed",
  "cancelled",
]);

/** Where the finished thing lives, and what to tell its maker about it. */
export type GenerationJobResult = { href: string; notice: string | null };

/** What the run is doing now: "Crawling" with 12 of 25 done. Counts are null when the step has none. */
export type GenerationJobProgress = { step: string; done: number | null; total: number | null };

export const generationJobs = pgTable(
  "generation_jobs",
  {
    id: primaryId(),
    workspaceId: tenantId(),
    /** Selects the runner (runners.ts), e.g. "learning.quiz". */
    kind: text("kind").notNull(),
    status: generationJobStatus("status").notNull().default("queued"),
    /** The caller's intent key: a repeated submit returns this job, never a second one. */
    idempotencyKey: text("idempotency_key").notNull(),
    /**
     * What the work is for, when a surface shows jobs for one thing only:
     * "notebook:<id>", "document:<id>". Null for work that belongs to no one thing.
     */
    subject: text("subject"),
    /** What a list shows while the work runs. */
    title: text("title").notNull(),
    input: jsonb("input").notNull(),
    result: jsonb("result").$type<GenerationJobResult>(),
    /** Authored copy for the person; a driver's message never lands here. */
    error: text("error"),
    attempt: integer("attempt").notNull().default(1),
    /** Bumped while a run is alive; a running job whose heartbeat stopped has stalled. */
    heartbeatAt: timestamp("heartbeat_at", { withTimezone: true }),
    /** The running attempt's latest step; cleared when an attempt is queued. */
    progress: jsonb("progress").$type<GenerationJobProgress>(),
    /** Moves with `progress`, so a stream sees a step change as well as a status change. */
    progressAt: timestamp("progress_at", { withTimezone: true }),
    /** Paid provider spend across every attempt, in millionths of a US dollar. */
    costMicroUsd: integer("cost_micro_usd").notNull().default(0),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    /** Moves on a status change only, so it orders what a stream has not sent yet. */
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("generation_jobs_idempotency_key").on(t.workspaceId, t.idempotencyKey),
    index("generation_jobs_owner_status_idx").on(t.workspaceId, t.createdBy, t.status),
    index("generation_jobs_owner_updated_idx").on(t.workspaceId, t.createdBy, t.updatedAt),
    index("generation_jobs_owner_progress_idx").on(t.workspaceId, t.createdBy, t.progressAt),
    check("generation_jobs_result_check", sql`(status = 'ready') = (result is not null)`),
    check("generation_jobs_error_check", sql`(status = 'failed') = (error is not null)`),
    check("generation_jobs_attempt_check", sql`attempt >= 1`),
    check("generation_jobs_cost_check", sql`cost_micro_usd >= 0`),
  ],
);
