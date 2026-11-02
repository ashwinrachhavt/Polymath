import { and, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { recordAudit } from "@/domains/audit/record";
import { withReceipt } from "@/domains/audit/receipt";
import { outboxEvents } from "@/domains/audit/schema";
import { captures } from "@/domains/capture/schema";
import type { AuthContext } from "@/domains/identity/resolve";
import { db } from "@/lib/db";
import { withTransaction, type TxDrizzle } from "@/lib/db-transaction";
import { isUniqueViolation } from "@/lib/pg-errors";
import { recordFocusReward } from "@/domains/gamification/commands";
import { tasks } from "@/domains/work/schema";
import { focusBlocklist, focusSessions, focusStrictness, type FocusStrictness } from "./schema";
import { TIMEOUT_PAUSE_LIMIT, abandonRemainingSeconds, elapsedSecondsAt, timeoutAutoResumeAt } from "./strictness";

/*
 * Focus session lifecycle (ASH-137 A09). The server clock is authoritative:
 * elapsed time is accumulatedSeconds plus, while running, the time since
 * lastResumedAt (or startedAt). A pause banks the running stretch into
 * accumulatedSeconds; a finish banks it and closes. A client timer only ever
 * displays this state - a refresh, a navigation, or a second tab resumes the
 * same session instead of starting a rival one.
 *
 * Spec §1 adds strictness tiers the server enforces on every transition:
 * deep cannot pause and finishes only at its planned time; timeout pauses at
 * most twice, each break capped at five minutes by a server auto-resume; and
 * both cool down before a requested abandon confirms. The tier lives on the
 * row, and every guard reads it from the same transaction as the guarded
 * UPDATE - the version pin closes the read-then-write gap.
 *
 * At most one session is live (running or paused) per workspace; the partial
 * unique index focus_sessions_active_idx is the real guard, so two tabs
 * racing a start get one session and one conflict, never two sessions.
 * Every transition re-checks both the expected version and the state it
 * moves from, so a retried or double-clicked action is a stale-write error,
 * not a duplicate pause entry or a resurrected session.
 */

export class ConflictError extends Error {
  readonly code = "conflict";
  /** The live row already holding the contested key, when the conflict has one — additive context, like the captures contract. */
  constructor(
    message: string,
    readonly existingId?: string,
  ) {
    super(message);
    this.name = "ConflictError";
  }
}

export class StaleWriteError extends Error {
  readonly code = "stale_write";
}

export async function startFocusSession(
  auth: AuthContext,
  input: {
    taskId?: string | null;
    subject?: string | null;
    plannedMinutes?: number | null;
    strictness?: FocusStrictness | null;
  },
) {
  if (input.strictness && !focusStrictness.enumValues.includes(input.strictness)) {
    throw new ConflictError("That strictness tier does not exist.");
  }
  try {
    return await withTransaction(async (tx) => {
      if (input.taskId) {
        const [task] = await tx
          .select({ id: tasks.id })
          .from(tasks)
          .where(and(eq(tasks.id, input.taskId), eq(tasks.workspaceId, auth.workspaceId), isNull(tasks.archivedAt)))
          .limit(1);
        if (!task) throw new ConflictError("That task does not exist in this workspace.");
      }
      const [session] = await tx
        .insert(focusSessions)
        .values({
          workspaceId: auth.workspaceId,
          taskId: input.taskId ?? null,
          subject: input.subject ?? null,
          plannedMinutes: input.plannedMinutes ?? null,
          strictness: input.strictness ?? "normal",
          state: "running",
          startedAt: new Date(),
          lastResumedAt: new Date(),
          createdBy: auth.userId,
          updatedBy: auth.userId,
        })
        .returning();
      await recordAudit(
        auth,
        {
          action: "focus_session.started",
          subjectType: "focus_session",
          subjectId: session.id,
          summary: session.subject ? `Focus started: ${session.subject}` : "Focus started",
        },
        tx,
      );
      return session;
    });
  } catch (cause) {
    if (isUniqueViolation(cause)) {
      throw new ConflictError("A focus session is already running. Finish or abandon it first.");
    }
    throw cause;
  }
}

type LiveTransition = {
  sessionId: string;
  expectedVersion: number;
  reason?: string | null;
  outcome?: string | null;
  whatChanged?: string | null;
  nextStep?: string | null;
};

/*
 * One guarded UPDATE per transition. The WHERE clause carries the expected
 * version and the states the transition is allowed from; zero rows back
 * means the session moved on since the caller looked, which is a stale write.
 * Before the UPDATE, the current row is read in the same transaction and any
 * `guard` runs against it: a tier rule (spec §1) rejects with a ConflictError
 * that says why, while the UPDATE's version pin keeps a concurrent change
 * from turning a passed guard into a stale write.
 */
async function transition(
  auth: AuthContext,
  input: LiveTransition,
  fromStates: Array<"running" | "paused">,
  patch: (now: Date, current: typeof focusSessions.$inferSelect | undefined) => Record<string, unknown>,
  audit: { action: string; summary: string },
  /** Extra writes in the same transaction (e.g. the follow-up outbox event). */
  extra?: (tx: TxDrizzle, updated: typeof focusSessions.$inferSelect) => Promise<void>,
  /** ASH-305: run inside the caller's transaction (the shutdown ritual's one atomic apply). */
  outer?: TxDrizzle,
  /** Spec §1 tier rules: reads the row as it is, throws a ConflictError to refuse the transition. */
  guard?: (current: typeof focusSessions.$inferSelect, now: Date) => void,
) {
  const run = outer ? <T>(fn: (tx: TxDrizzle) => Promise<T>) => fn(outer) : withTransaction;
  return run(async (tx) => {
    const now = new Date();
    const [current] = await tx
      .select()
      .from(focusSessions)
      .where(and(eq(focusSessions.id, input.sessionId), eq(focusSessions.workspaceId, auth.workspaceId)))
      .limit(1);
    if (guard && current && current.startedAt && fromStates.includes(current.state as (typeof fromStates)[number])) {
      // Tier rules constrain legal transitions; an illegal-state request
      // (e.g. a planned row) stays a stale-write rejection from the UPDATE.
      guard(current, now);
    }
    const [updated] = await tx
      .update(focusSessions)
      .set({
        ...patch(now, current),
        version: sql`${focusSessions.version} + 1`,
        updatedAt: now,
        updatedBy: auth.userId,
      })
      .where(
        and(
          eq(focusSessions.id, input.sessionId),
          eq(focusSessions.workspaceId, auth.workspaceId),
          eq(focusSessions.version, input.expectedVersion),
          sql`${focusSessions.state} in (${sql.join(
            fromStates.map((s) => sql`${s}`),
            sql`, `,
          )})`,
          // Lifecycle transitions move time, so they require a session that
          // started: a planned row (started_at null, ASH-308) can only be
          // started, dismissed, or left alone - never paused, resumed,
          // finished, or abandoned.
          isNotNull(focusSessions.startedAt),
        ),
      )
      .returning();
    if (!updated) {
      throw new StaleWriteError("The focus session changed since you loaded it. Reload and try again.");
    }
    await recordAudit(
      auth,
      { action: audit.action, subjectType: "focus_session", subjectId: updated.id, summary: audit.summary },
      tx,
    );
    if (extra) await extra(tx, updated);
    return updated;
  });
}

/* Interruption log entries: [{ at, reason }] per the schema contract. */
const logEntry = (at: Date, reason: string) =>
  sql`coalesce(${focusSessions.interruptions}, '[]'::jsonb) || ${JSON.stringify([{ at: at.toISOString(), reason }])}::jsonb`;

export async function pauseFocusSession(auth: AuthContext, input: LiveTransition) {
  return transition(
    auth,
    input,
    ["running"],
    (now) => ({
      state: "paused",
      // Bank the running stretch: from the last resume (or start) to now.
      accumulatedSeconds: sql`${focusSessions.accumulatedSeconds} + floor(extract(epoch from (${now.toISOString()}::timestamptz - coalesce(${focusSessions.lastResumedAt}, ${focusSessions.startedAt}))))::int`,
      // Structural count: the timeout tier's two-pause cap is an invariant,
      // not something to derive from free-text interruption reasons.
      pauseCount: sql`${focusSessions.pauseCount} + 1`,
      interruptions: logEntry(now, input.reason?.trim() || "paused"),
    }),
    { action: "focus_session.paused", summary: "Focus paused" },
    undefined,
    undefined,
    (current) => {
      // Spec §1: deep focus holds - a pause would let the clock run down
      // without the attention the tier exists to protect.
      if (current.strictness === "deep") {
        throw new ConflictError("Deep focus does not pause. Finish it when the planned time is up.");
      }
      if (current.strictness === "timeout" && current.pauseCount >= TIMEOUT_PAUSE_LIMIT) {
        throw new ConflictError(
          "Timeout focus allows two pauses. Finish the session, or take the next break after it ends.",
        );
      }
    },
  );
}

export async function resumeFocusSession(auth: AuthContext, input: LiveTransition) {
  return transition(
    auth,
    input,
    ["paused"],
    (now, current) => {
      // Spec §1 (timeout tier): a break longer than five minutes ends itself.
      // The server resumes the clock at the cap - the break costs five
      // minutes, no more - regardless of when the click lands.
      const autoResumeAt = current ? timeoutAutoResumeAt(current, now) : null;
      const resumedAt = autoResumeAt ?? now;
      return {
        state: "running",
        lastResumedAt: resumedAt,
        // Back to work is a decision to continue: a pending abandon request dissolves.
        abandonRequestedAt: null,
        interruptions: logEntry(resumedAt, autoResumeAt ? "auto-resumed" : "resumed"),
      };
    },
    { action: "focus_session.resumed", summary: "Focus resumed" },
  );
}

export async function finishFocusSession(auth: AuthContext, input: LiveTransition, outer?: TxDrizzle) {
  return transition(
    auth,
    input,
    ["running", "paused"],
    (now) => ({
      state: "finished",
      endedAt: now,
      outcome: input.outcome?.trim() || null,
      whatChanged: input.whatChanged?.trim() || null,
      nextStep: input.nextStep?.trim() || null,
      // A finish from running banks the open stretch; from paused, nothing is open.
      accumulatedSeconds: sql`${focusSessions.accumulatedSeconds} + case when ${focusSessions.state} = 'running' then floor(extract(epoch from (${now.toISOString()}::timestamptz - coalesce(${focusSessions.lastResumedAt}, ${focusSessions.startedAt}))))::int else 0 end`,
    }),
    { action: "focus_session.finished", summary: "Focus finished" },
    async (tx, updated) => {
      // ASH-288: a finished session that touched a task MAY earn the follow-up
      // hand-off. The event is enqueued here, in the finish's own transaction,
      // so a committed finish never loses its one shot; the handler decides
      // (deterministically) whether a party resolution justifies the run.
      // Deduped on the session id: a replayed finish cannot double-start.
      if (updated.taskId) {
        await tx
          .insert(outboxEvents)
          .values({
            workspaceId: auth.workspaceId,
            topic: "focus.follow_up_requested",
            payload: { sessionId: updated.id },
            dispatchKey: updated.id,
          })
          .onConflictDoNothing();
      }
      // Spec §5: the finish is what pays. The award, the progress it moves,
      // and the stones it unlocks ride this same transaction - a committed
      // finish never lacks its reward, and a reward cannot exist without its
      // finish. The abandon paths below never reach this hook: letting go
      // earns nothing. Never throws for game reasons.
      //
      // The two stone premises are focus-domain facts, gathered here so the
      // gamification rule never joins across domains: whether the linked
      // task is high-priority, and whether this user has ever let a session
      // go (the recovery stone's premise).
      let linkedTaskPriority: (typeof tasks.$inferSelect)["priority"] | null = null;
      if (updated.taskId) {
        const [task] = await tx
          .select({ priority: tasks.priority })
          .from(tasks)
          .where(and(eq(tasks.id, updated.taskId), eq(tasks.workspaceId, auth.workspaceId)))
          .limit(1);
        linkedTaskPriority = task?.priority ?? null;
      }
      const [dropped] = await tx
        .select({ id: focusSessions.id })
        .from(focusSessions)
        .where(
          and(
            eq(focusSessions.workspaceId, auth.workspaceId),
            eq(focusSessions.createdBy, auth.userId),
            eq(focusSessions.state, "abandoned"),
          ),
        )
        .limit(1);

      await recordFocusReward(tx, auth, {
        id: updated.id,
        accumulatedSeconds: updated.accumulatedSeconds,
        strictness: updated.strictness,
        linkedTaskPriority,
        followedAbandon: dropped !== undefined,
      });
    },
    outer,
    (current, now) => {
      // Spec §1: a deep session finishes when it said it would. Stopping
      // early is quitting, not finishing - the guard says how much is left.
      if (current.strictness !== "deep") return;
      const planned = (current.plannedMinutes ?? 0) * 60;
      if (planned <= 0) return; // Nothing planned to hold to.
      const elapsed = elapsedSecondsAt(current, now);
      if (elapsed < planned) {
        const minutesLeft = Math.ceil((planned - elapsed) / 60);
        throw new ConflictError(
          `Deep focus holds for the full ${current.plannedMinutes} minutes - about ${minutesLeft} minute${minutesLeft === 1 ? "" : "s"} left.`,
        );
      }
    },
  );
}

export async function abandonFocusSession(auth: AuthContext, input: LiveTransition, outer?: TxDrizzle) {
  return transition(
    auth,
    input,
    ["running", "paused"],
    (now) => ({
      state: "abandoned",
      endedAt: now,
      outcome: input.reason?.trim() || null,
    }),
    { action: "focus_session.abandoned", summary: "Focus abandoned" },
    undefined,
    outer,
  );
}

/*
 * Spec §1: leaving a strict session is a two-step door. requestAbandon
 * records the intent (abandon_requested_at); confirmAbandon goes through
 * only once the tier's cooldown has passed on the server clock - deep 60s,
 * timeout 30s, normal 0 - so an impulse cannot end a held session and
 * waiting cannot be skipped. The request does not touch the interruption
 * log: in state 'paused' the log's last entry must stay the pause itself,
 * which is the anchor the timeout auto-resume reads.
 *
 * The one-shot abandonFocusSession above remains the shutdown ritual's
 * deliberate close: its own flow already forces an explicit per-session
 * choice (finish, abandon, or leave), which is the guard there.
 */
export async function requestAbandonFocusSession(auth: AuthContext, input: LiveTransition) {
  return transition(auth, input, ["running", "paused"], (now) => ({ abandonRequestedAt: now }), {
    action: "focus_session.abandon_requested",
    summary: "Abandon requested",
  });
}

export async function confirmAbandonFocusSession(auth: AuthContext, input: LiveTransition) {
  return transition(
    auth,
    input,
    ["running", "paused"],
    (now) => ({
      state: "abandoned",
      endedAt: now,
      outcome: input.reason?.trim() || null,
    }),
    { action: "focus_session.abandoned", summary: "Focus abandoned" },
    undefined,
    undefined,
    (current, now) => {
      if (!current.abandonRequestedAt) {
        throw new ConflictError("Request the abandon first - the cooldown starts when you ask.");
      }
      const remaining = abandonRemainingSeconds(current.strictness, current.abandonRequestedAt, now);
      if (remaining > 0) {
        throw new ConflictError(`The abandon cools down for ${remaining}s more.`);
      }
    },
  );
}

/*
 * ASH-308: a capture dropped on a theatre slot becomes a planned session.
 * "Planned" is derived - scheduledAt set, startedAt null. The ticket forbids
 * an enum change, so the row borrows state 'paused' and is told apart from a
 * real paused session by its columns: a real pause always has startedAt and
 * never has an un-started scheduledAt. The capture row is never mutated; the
 * session points at it. The drag's idempotency key is a request receipt: a
 * double-drop replays the first session, never creates a second one.
 */
export async function scheduleSessionFromCapture(
  auth: AuthContext,
  input: { captureId: string; scheduledAt: Date; idempotencyKey?: string },
) {
  if (!(input.scheduledAt instanceof Date) || Number.isNaN(input.scheduledAt.getTime())) {
    throw new ConflictError("That slot is not a time.");
  }
  if (input.scheduledAt.getTime() < Date.now() - 60_000) {
    throw new ConflictError("That slot has already passed.");
  }
  return withTransaction(async (tx) => {
    const [capture] = await tx
      .select({ id: captures.id, title: captures.title, text: captures.text })
      .from(captures)
      .where(and(eq(captures.id, input.captureId), eq(captures.workspaceId, auth.workspaceId)))
      .limit(1);
    if (!capture) throw new ConflictError("That capture does not exist in this workspace.");

    const { value, replayed } = await withReceipt(
      tx,
      auth,
      input.idempotencyKey,
      { captureId: input.captureId, scheduledAt: input.scheduledAt.toISOString() },
      async () => {
        const [session] = await tx
          .insert(focusSessions)
          .values({
            workspaceId: auth.workspaceId,
            captureId: capture.id,
            // A capture's person-supplied title lives in rawPayload until
            // enrichment runs, so the column is usually null here; the block
            // needs a name either way, and the text is the honest fallback.
            subject: capture.title ?? capture.text?.slice(0, 80) ?? null,
            // Borrowed, not meaningful: the enum cannot grow (ticket constraint).
            // Every read that matters derives "planned" from the columns.
            state: "paused",
            scheduledAt: input.scheduledAt,
            // The durable clock starts when the session does, not when it is planned.
            startedAt: null,
            createdBy: auth.userId,
            updatedBy: auth.userId,
          })
          .returning();
        await recordAudit(
          auth,
          {
            action: "focus.session_scheduled",
            subjectType: "focus_session",
            subjectId: session.id,
            summary: `Scheduled: ${session.subject ?? "capture"} at ${input.scheduledAt.toISOString()}`,
          },
          tx,
        );
        return { sessionId: session.id };
      },
    );
    return { sessionId: value.sessionId, replayed };
  });
}

/*
 * Dismissing a scheduled block deletes the row: it never ran, so there is
 * nothing to preserve. Only a not-yet-started scheduled row can go - a
 * started session belongs to the lifecycle transitions above.
 */
export async function unscheduleFocusSession(auth: AuthContext, input: { sessionId: string }) {
  return withTransaction(async (tx) => {
    const [removed] = await tx
      .delete(focusSessions)
      .where(
        and(
          eq(focusSessions.id, input.sessionId),
          eq(focusSessions.workspaceId, auth.workspaceId),
          eq(focusSessions.state, "paused"),
          isNull(focusSessions.startedAt),
          isNotNull(focusSessions.scheduledAt),
        ),
      )
      .returning({ id: focusSessions.id, subject: focusSessions.subject });
    if (!removed) {
      throw new StaleWriteError("That scheduled session changed since you loaded it. Reload and try again.");
    }
    await recordAudit(
      auth,
      {
        action: "focus.session_unscheduled",
        subjectType: "focus_session",
        subjectId: removed.id,
        summary: `Unscheduled: ${removed.subject ?? "capture"}`,
      },
      tx,
    );
    return { sessionId: removed.id };
  });
}

/*
 * scheduled -> started: the existing start flow takes over, but it takes over
 * THIS row - the planned session becomes the live one rather than spawning a
 * rival. Same guards as any start: one live session per workspace.
 */
export async function startScheduledFocusSession(
  auth: AuthContext,
  input: { sessionId: string; expectedVersion: number },
) {
  try {
    return await withTransaction(async (tx) => {
      const now = new Date();
      const [updated] = await tx
        .update(focusSessions)
        .set({
          state: "running",
          startedAt: now,
          lastResumedAt: now,
          version: sql`${focusSessions.version} + 1`,
          updatedAt: now,
          updatedBy: auth.userId,
        })
        .where(
          and(
            eq(focusSessions.id, input.sessionId),
            eq(focusSessions.workspaceId, auth.workspaceId),
            eq(focusSessions.version, input.expectedVersion),
            eq(focusSessions.state, "paused"),
            isNull(focusSessions.startedAt),
            isNotNull(focusSessions.scheduledAt),
          ),
        )
        .returning();
      if (!updated) {
        throw new StaleWriteError("That scheduled session changed since you loaded it. Reload and try again.");
      }
      await recordAudit(
        auth,
        {
          action: "focus_session.started",
          subjectType: "focus_session",
          subjectId: updated.id,
          summary: updated.subject ? `Focus started: ${updated.subject}` : "Focus started",
        },
        tx,
      );
      return updated;
    });
  } catch (cause) {
    if (isUniqueViolation(cause)) {
      throw new ConflictError("A focus session is already running. Finish or abandon it first.");
    }
    throw cause;
  }
}

/*
 * Blocklist curation (setup screen + /api/v1/focus/blocklist). The extension
 * only ever READS these rows, so every write here is a signed-in member's
 * act: a machine key that could weaken the blocklist would let a blocked
 * page un-block itself through its own companion. Patterns are canonicalized
 * (trimmed, lowercased) before the unique key sees them, so case variants
 * dedupe into one entry.
 */

function canonicalBlocklistPattern(pattern: string): string {
  return pattern.trim().toLowerCase();
}

export async function createFocusBlocklistEntry(
  auth: AuthContext,
  input: { pattern: string; kind?: "block" | "allow" },
) {
  const pattern = canonicalBlocklistPattern(input.pattern);
  try {
    const [entry] = await db
      .insert(focusBlocklist)
      .values({
        workspaceId: auth.workspaceId,
        pattern,
        kind: input.kind ?? "block",
        createdBy: auth.userId,
        updatedBy: auth.userId,
      })
      .returning();
    return entry;
  } catch (cause) {
    // Two tabs racing the same pattern: the partial unique index picks one
    // winner, the loser answers 409 pointing at the row that is already there.
    if (isUniqueViolation(cause, "focus_blocklist_pattern_key")) {
      const [existing] = await db
        .select({ id: focusBlocklist.id })
        .from(focusBlocklist)
        .where(
          and(
            eq(focusBlocklist.workspaceId, auth.workspaceId),
            eq(focusBlocklist.pattern, pattern),
            isNull(focusBlocklist.archivedAt),
          ),
        )
        .limit(1);
      throw new ConflictError("That pattern is already on the blocklist.", existing?.id);
    }
    throw cause;
  }
}

export async function updateFocusBlocklistEntry(
  auth: AuthContext,
  blockId: string,
  input: { pattern?: string; kind?: "block" | "allow" },
) {
  // A settings row converges under last-write-wins: there is no state machine
  // to corrupt, and the response carries the row the winner wrote.
  try {
    const [entry] = await db
      .update(focusBlocklist)
      .set({
        // The set source takes a per-column SQL escape hatch, which is how the
        // version bump stays an atomic increment rather than a read-modify-write.
        ...(input.pattern !== undefined ? { pattern: canonicalBlocklistPattern(input.pattern) } : {}),
        ...(input.kind !== undefined ? { kind: input.kind } : {}),
        updatedBy: auth.userId,
        updatedAt: new Date(),
        version: sql`${focusBlocklist.version} + 1`,
      })
      .where(
        and(
          eq(focusBlocklist.id, blockId),
          eq(focusBlocklist.workspaceId, auth.workspaceId),
          isNull(focusBlocklist.archivedAt),
        ),
      )
      .returning();
    return entry ?? null;
  } catch (cause) {
    if (isUniqueViolation(cause, "focus_blocklist_pattern_key")) {
      throw new ConflictError("That pattern is already on the blocklist.");
    }
    throw cause;
  }
}

/** Archiving, not deleting: the pattern's history stays in the row, and the partial unique key frees it for re-adding. */
export async function archiveFocusBlocklistEntry(auth: AuthContext, blockId: string) {
  const [entry] = await db
    .update(focusBlocklist)
    .set({
      archivedAt: new Date(),
      updatedBy: auth.userId,
      updatedAt: new Date(),
      version: sql`${focusBlocklist.version} + 1`,
    })
    .where(
      and(
        eq(focusBlocklist.id, blockId),
        eq(focusBlocklist.workspaceId, auth.workspaceId),
        isNull(focusBlocklist.archivedAt),
      ),
    )
    .returning();
  return entry ?? null;
}
