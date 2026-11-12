import { and, desc, eq, inArray, like, or, sql } from "drizzle-orm";
import type { AuthContext } from "@/domains/identity/resolve";
import { db } from "@/lib/db";
import { escapeLike } from "@/lib/list-params";
import { jobViewColumns } from "./commands";
import { generationJobs } from "./schema";
import { toJobView, type GenerationJobView } from "./state";

/*
 * The read side of generation jobs. A person sees their own jobs only: the
 * finished thing is shared through its own domain's lists, the wait is theirs.
 */

type Owner = Pick<AuthContext, "workspaceId" | "userId">;

function mine(auth: Owner) {
  return and(eq(generationJobs.workspaceId, auth.workspaceId), eq(generationJobs.createdBy, auth.userId));
}

/**
 * The jobs a page should show on load: still being made, or failed and not
 * yet dismissed. Newest first. `kindPrefix` narrows to one surface's kinds,
 * e.g. "learning."; `subject` narrows further to the jobs made for one thing.
 */
export async function listUnfinishedGenerationJobs(
  auth: Owner,
  input: { kindPrefix: string; subject?: string; limit?: number },
): Promise<GenerationJobView[]> {
  const rows = await db
    .select(jobViewColumns)
    .from(generationJobs)
    .where(
      and(
        mine(auth),
        inArray(generationJobs.status, ["queued", "running", "failed"]),
        like(generationJobs.kind, `${escapeLike(input.kindPrefix)}%`),
        input.subject === undefined ? undefined : eq(generationJobs.subject, input.subject),
      ),
    )
    .orderBy(desc(generationJobs.createdAt), desc(generationJobs.id))
    .limit(input.limit ?? 20);
  return rows.map(toJobView);
}

/** How far behind `since` a tail looks, so a change committed just after the last read is not missed. */
const TAIL_OVERLAP_MS = 5_000;

/**
 * What a stream needs for one pass: every job still being made, plus every
 * job whose status changed since `since` (null: since now). `now` is the
 * database's clock at the read; pass it back as the next `since`. Passes
 * overlap, so the caller skips what it already sent (jobSignature).
 */
export async function tailGenerationJobs(
  auth: Owner,
  since: Date | null,
): Promise<{ jobs: GenerationJobView[]; now: Date }> {
  const from = since ? sql`${since.toISOString()}::timestamptz` : sql`now()`;
  const rows = await db
    .select({ ...jobViewColumns, now: sql<string>`now()` })
    .from(generationJobs)
    .where(
      and(
        mine(auth),
        or(
          inArray(generationJobs.status, ["queued", "running"]),
          sql`${generationJobs.updatedAt} > ${from} - (${TAIL_OVERLAP_MS}::double precision * interval '1 millisecond')`,
        ),
      ),
    )
    .orderBy(generationJobs.updatedAt)
    .limit(100);
  const now = rows[0] ? new Date(rows[0].now) : await databaseNow();
  return { jobs: rows.map(toJobView), now };
}

async function databaseNow(): Promise<Date> {
  const [row] = await db.execute<{ now: string }>(sql`select now() as now`);
  return new Date(row.now);
}
