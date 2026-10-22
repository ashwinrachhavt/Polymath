import type postgres from "postgres";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { DEFAULT_MODEL_ID } from "./models";
import { agentProfiles } from "./schema";

/*
 * The first-party profile, ensured before a start so the engine's lookup
 * succeeds. One owner in v1 ships one profile (agents/product.md): idempotent
 * on (workspace, name) via the unique index, so two racing starts land on one
 * row.
 *
 * ponytail: model id and budget defaults live here, not in a settings screen,
 * until profile management lands.
 */
/** The first-party profile's capabilities. documents.search and the wiki tools are reads or internal writes. */
export const DEFAULT_ALLOWED_TOOLS = [
  "tasks.read",
  "documents.search",
  "wiki.read",
  "wiki.ingest",
  "wiki.lint",
  "gmail.send",
  // Connected reads. A capability in the risk table but absent here can never
  // be granted: the policy snapshot copies this list verbatim, so the tool is
  // advertised to the model and denied on every call.
  "gmail.read",
  // Same authority as searching mail; without a row the thread tool is a
  // dead 403 on every call.
  "gmail.thread.read",
  // GitHub and Slack reads, advertised through the same gateway.
  "github.read",
  "github.issue.read",
  "slack.channels.read",
  "slack.read",
  "linear.read",
  "linear.issue.read",
  "calendar.read",
  "notion.read",
  // NotebookLM parity. Opening a notebook reads; grading a review writes an
  // attempt locally, the same act the owner performs in the UI.
  "notebook.open",
  "learning.review",
  // Run follow-ups become reviewable task proposals, never silent task
  // writes: the tool creates a prepare-risk proposal and the owner's approval
  // creates the task. Same class as wiki.ingest, which also writes locally.
  "tasks.create",
  // Public-web reads. Query terms and fetched URLs leave the workspace (the
  // registry's egress note), nothing is written, and the zero-key provider
  // means no spend. web.fetch answers a clear config error until a Firecrawl
  // URL is set; granting it keeps the refusal honest instead of a dead 403.
  "web.search",
  "web.fetch",
];

export async function ensureProfile(workspaceId: string, name = "alfred") {
  const [existing] = await db
    .select({ id: agentProfiles.id, allowedTools: agentProfiles.allowedTools })
    .from(agentProfiles)
    .where(eq(agentProfiles.workspaceId, workspaceId))
    .limit(1);
  if (existing) {
    // A profile made before documents.search existed gains that read-only
    // capability. Nothing else is added, and runs already started keep their
    // frozen snapshot.
    const tools = Array.isArray(existing.allowedTools) ? (existing.allowedTools as string[]) : [];
    // Reads and internal wiki writes gained after early profiles were made.
    // Nothing else is added, and runs already started keep their frozen snapshot.
    // Connected reads are here for the same reason as the wiki ones: an
    // existing profile's frozen list would otherwise never gain them, and the
    // tool would fail closed forever with "not in this run's policy snapshot".
    // `gmail.thread.read` is in this list for the same reason: it ships as a
    // gateway tool, so a profile without it makes the tool a dead 403.
    const gained = [
      "documents.search",
      "wiki.read",
      "wiki.ingest",
      "wiki.lint",
      "gmail.read",
      "gmail.thread.read",
      "github.read",
      "github.issue.read",
      "slack.channels.read",
      "slack.read",
      "linear.read",
      "linear.issue.read",
      "calendar.read",
      "notion.read",
      "notebook.open",
      "learning.review",
      // Prepare-risk proposal writes gained with the tasks_propose tool;
      // without this, existing profiles would fail closed on every call.
      "tasks.create",
      // Public-web reads granted with the default profile; an existing
      // profile without them makes the tools a dead 403 on every call.
      "web.search",
      "web.fetch",
    ];
    const missing = gained.filter((t) => !tools.includes(t));
    if (missing.length) {
      await db.update(agentProfiles).set({ allowedTools: [...tools, ...missing] }).where(eq(agentProfiles.id, existing.id));
    }
    return existing.id;
  }
  const [profile] = await db
    .insert(agentProfiles)
    .values({
      workspaceId,
      name,
      // Placeholder, not a persona: the workspace's supervisor is the user's
      // own representation (agents/product.md, revised 2026-10-21). Onboarding
      // or the operator replaces this description with the personified brief;
      // shipping a fixed "Chief of staff" persona would silently contradict
      // what the run's instructions say it is.
      description: "Your agent. Name it and shape it in Settings to make it yours.",
      // The catalog's default, not a stale provider id: the run frozen from
      // this row is what spend is priced against, so it has to name a model
      // that exists.
      modelPolicy: { primary: DEFAULT_MODEL_ID },
      allowedTools: DEFAULT_ALLOWED_TOOLS,
      budgetPolicy: { perRunCeilingUsd: "2.00", dailyCeilingUsd: "10.00" },
      isDefault: true,
    })
    .onConflictDoNothing()
    .returning({ id: agentProfiles.id });
  if (profile) return profile.id;
  const [raced] = await db
    .select({ id: agentProfiles.id })
    .from(agentProfiles)
    .where(eq(agentProfiles.workspaceId, workspaceId))
    .limit(1);
  if (!raced) throw new Error("agent profile did not persist");
  return raced.id;
}

/*
 * The orphaned-run remedy. A run whose worker died — a Vercel function evicted,
 * a crash between the queued row and the session — stays `queued`/`running`
 * forever, holding a spending reservation against the daily ceiling that no
 * caller will ever settle. This sweep is what closes it.
 *
 * Deliberately not a domain command: it takes the raw postgres-js client
 * because a cron sweep runs outside any request, has no AuthContext, and spans
 * every workspace. It cannot use closeRun, which is scoped to one workspace and
 * one auth. `for update skip locked` is the concurrency guard, so two
 * overlapping sweeps cannot both claim the same run.
 *
 * The two active states and the error text are constants, so they are inlined:
 * the sweep is the only writer, and a bound array makes postgres-js guess
 * parameter types (it mis-inferred a sibling Date as text, a `bytes.js` throw).
 * Ids stay bound — an `in` list of uuids is exactly what a parameter is for.
 */

/** The live states the run table's partial active index covers. */
const ACTIVE_IN = "'queued', 'running'";
const TIMED_OUT = "run timed out and was reconciled";

/**
 * Marks every queued/running run created before `olderThanMs` ago as failed,
 * releases its open spending reservation, and leaves one `run.reconciled`
 * event. Returns the ids it closed, for the caller's log or metric.
 */
export async function reconcileStaleRuns(
  rawClient: ReturnType<typeof postgres>,
  olderThanMs: number = 24 * 3600 * 1000,
): Promise<string[]> {
  const cutoff = new Date(Date.now() - olderThanMs).toISOString();
  const now = new Date().toISOString();

  return rawClient.begin(async (tx) => {
    const stale = await tx<{ id: string }[]>`
      select id from agent_runs
      where state::text in (${tx.unsafe(ACTIVE_IN)})
        and created_at < ${cutoff}::timestamptz
      for update skip locked
    `;
    if (stale.length === 0) return [];

    const ids = stale.map((row) => row.id);

    await tx`
      update agent_runs
      set state = 'failed',
          error = ${TIMED_OUT},
          ended_at = ${now}::timestamptz,
          updated_at = ${now}::timestamptz,
          version = version + 1
      where id = any(${ids})
    `;

    // Release, not settle: the run did no work, so its budget goes back. Guarded
    // on status = 'reserved' so a settled or already-released claim is untouched.
    await tx`
      update spending_reservations
      set status = 'released',
          updated_at = ${now}::timestamptz,
          version = version + 1
      where run_id = any(${ids}) and status = 'reserved'
    `;

    // One event per run, sequence claimed with max+1 — the shape appendEvent
    // uses, so a live SSE reader sees the close.
    await tx`
      insert into run_events (workspace_id, run_id, sequence, type, data, created_at)
      select r.workspace_id, r.id,
             coalesce((select max(e.sequence) from run_events e where e.run_id = r.id), 0) + 1,
             'run.reconciled',
             ${JSON.stringify({ error: TIMED_OUT })}::jsonb,
             ${now}::timestamptz
      from agent_runs r
      where r.id = any(${ids})
    `;

    await tx`
      update agent_runs
      set last_event_seq = greatest(last_event_seq,
            (select max(sequence) from run_events e where e.run_id = agent_runs.id))
      where id = any(${ids})
    `;

    return ids;
  });
}
