import { focusSessions, type FocusStrictness } from "./schema";

/*
 * Spec §1 tier rules as pure functions: the same math the guards enforce and
 * the read projections display, in one named place with no database in sight.
 * Every timing decision runs on the server clock a caller passes in - the
 * client never sends a time.
 */

/** Cooldown, in seconds, between requesting an abandon and confirming it. */
export const ABANDON_COOLDOWN_SECONDS: Record<FocusStrictness, number> = {
  normal: 0,
  timeout: 30,
  deep: 60,
};

/** A timeout session may pause at most this many times (spec §1). */
export const TIMEOUT_PAUSE_LIMIT = 2;

/** A timeout pause longer than this many seconds is ended by the server. */
export const TIMEOUT_PAUSE_CAP_SECONDS = 5 * 60;

/** The clock fields every elapsed computation reads; nothing else. */
export type ClockFields = Pick<
  typeof focusSessions.$inferSelect,
  "state" | "accumulatedSeconds" | "lastResumedAt" | "startedAt"
>;

/** Seconds of real elapsed focus at `now`: banked time plus, while running, the open stretch. */
export function elapsedSecondsAt(session: ClockFields, now: Date): number {
  const clockStart = session.lastResumedAt ?? session.startedAt;
  const openStretch =
    session.state === "running" && clockStart
      ? Math.max(0, Math.floor((now.getTime() - clockStart.getTime()) / 1000))
      : 0;
  return session.accumulatedSeconds + openStretch;
}

/**
 * Seconds left on the plan at `now`; null when the session set no planned
 * time. Deep-tier interstitials read this to state what holds and until
 * when — the same authoritative-clock rule as elapsedSecondsAt.
 */
export function remainingSecondsAt(session: ClockFields & { plannedMinutes: number | null }, now: Date): number | null {
  if (session.plannedMinutes == null) return null;
  return Math.max(0, session.plannedMinutes * 60 - elapsedSecondsAt(session, now));
}

/**
 * When the live pause began. In state 'paused' the last interruption entry is
 * always the pause's own: only the pause transition moves a started session
 * into paused, and it appends exactly one entry; nothing else appends while
 * paused. A scheduled row (the borrowed 'paused', never started) has an empty
 * log and no anchor.
 */
export function pauseStartedAt(session: Pick<typeof focusSessions.$inferSelect, "interruptions">): Date | null {
  const log = Array.isArray(session.interruptions) ? (session.interruptions as Array<{ at?: unknown }>) : [];
  const last = log[log.length - 1];
  if (!last || typeof last.at !== "string") return null;
  const at = new Date(last.at);
  return Number.isNaN(at.getTime()) ? null : at;
}

/**
 * Spec §1 (timeout tier): a break longer than five minutes ends itself. The
 * server resumes the clock at the cap - the pause may cost five minutes, no
 * more - so the moment a resume lands after the cap, this returns the instant
 * the break should have ended. Null when the pause is still within the cap or
 * this is not an expired timeout pause.
 */
export function timeoutAutoResumeAt(
  session: Pick<typeof focusSessions.$inferSelect, "state" | "strictness" | "interruptions">,
  now: Date,
): Date | null {
  if (session.state !== "paused" || session.strictness !== "timeout") return null;
  const pausedAt = pauseStartedAt(session);
  if (!pausedAt) return null;
  const cap = pausedAt.getTime() + TIMEOUT_PAUSE_CAP_SECONDS * 1000;
  // At the cap exactly, the break is still legal; only past it does the server resume.
  if (now.getTime() <= cap) return null;
  return new Date(cap);
}

/** Seconds still owed before a requested abandon may be confirmed; 0 once the window has passed. */
export function abandonRemainingSeconds(strictness: FocusStrictness, requestedAt: Date, now: Date): number {
  const remainingMs = ABANDON_COOLDOWN_SECONDS[strictness] * 1000 - (now.getTime() - requestedAt.getTime());
  return remainingMs <= 0 ? 0 : Math.ceil(remainingMs / 1000);
}
