import { io } from "next/cache";
import { Screen } from "@/components/workspace/ui";
import { getAuthContext } from "@/lib/auth";
import { getFocusFollowUp } from "@/domains/focus/queries";
import { ABANDON_COOLDOWN_SECONDS, TIMEOUT_PAUSE_CAP_SECONDS, TIMEOUT_PAUSE_LIMIT } from "@/domains/focus/strictness";
import {
  getActiveFocusSessionForPage,
  getLastTaskHandoffForPage,
  listFocusHistoryForPage,
  listWorkRowsForPage,
} from "../work/data";
import { LiveSession } from "./live-session";
import { FocusSetup } from "./setup-form";
import { ClosedSummary } from "./summary";

export const metadata = { title: "Focus · Polymath" };

/*
 * The Focus screen (spec §3): setup, live, and summary for the one session a
 * workspace runs at a time. The server owns the clock and the tier contract;
 * this page renders the durable row, and every transition is a server action
 * that re-derives the truth in Postgres. The blocklist the setup curates is
 * enforced by the browser companion, which only ever reads it.
 */

/**
 * The tier picker's copy, built here so every number comes from the same
 * constants the server guards enforce - the labels can only drift if the
 * rules do.
 */
const tierOptions = [
  {
    value: "normal" as const,
    label: "Normal",
    detail: "Pauses and breaks behave as always. Abandon confirms immediately.",
  },
  {
    value: "timeout" as const,
    label: "Timeout",
    detail: `At most ${TIMEOUT_PAUSE_LIMIT} pauses, each break capped at ${TIMEOUT_PAUSE_CAP_SECONDS / 60} minutes - the server resumes the clock at the cap. Abandon cools down ${ABANDON_COOLDOWN_SECONDS.timeout}s.`,
  },
  {
    value: "deep" as const,
    label: "Deep",
    detail: `No pauses. The session finishes only when the planned time is up. Abandon cools down ${ABANDON_COOLDOWN_SECONDS.deep}s.`,
  },
];

export default async function FocusPage() {
  // Per-user data: render at request time, never prerender.
  await io();
  const auth = await getAuthContext();
  const [activeSession, openRows, history] = await Promise.all([
    getActiveFocusSessionForPage(auth),
    listWorkRowsForPage(auth, "open"),
    listFocusHistoryForPage(auth, 8),
  ]);
  const latest = history[0] ?? null;
  const [handoff, followUp] = await Promise.all([
    activeSession?.taskId ? getLastTaskHandoffForPage(auth, activeSession.taskId) : null,
    latest ? getFocusFollowUp(auth, latest.id) : null,
  ]);
  // A closed session always carries its end timestamp; spreading the narrowed
  // value gives the summary the non-null type it renders.
  const latestClosed = latest?.endedAt ? { ...latest, endedAt: latest.endedAt } : null;

  return (
    <Screen title="Focus" description="Run a strict focus session.">
      {activeSession ? (
        <LiveSession
          key={`${activeSession.id}:${activeSession.version}`}
          session={{
            id: activeSession.id,
            taskId: activeSession.taskId,
            subject: activeSession.subject,
            taskTitle: activeSession.taskTitle,
            state: activeSession.state as "running" | "paused",
            strictness: activeSession.strictness,
            plannedMinutes: activeSession.plannedMinutes,
            elapsedSeconds: activeSession.elapsedSeconds,
            version: activeSession.version,
          }}
          handoff={handoff}
        />
      ) : (
        <FocusSetup tasks={openRows.map((row) => ({ id: row.id, title: row.title }))} tiers={tierOptions} />
      )}
      {!activeSession && latestClosed ? <ClosedSummary session={latestClosed} followUp={followUp} /> : null}
    </Screen>
  );
}
