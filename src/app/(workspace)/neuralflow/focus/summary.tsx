import { Status } from "@/components/workspace/ui";
import type { FocusFollowUpStatus, FocusSessionView } from "@/domains/focus/queries";

/*
 * The last closed session's record (spec §3): what the session was, what it
 * produced, and where the follow-up ghost took it. A fresh workspace with no
 * closed sessions renders nothing here - the summary speaks only when there
 * is a record to show.
 */

const tierLabels: Record<FocusSessionView["strictness"], string> = {
  normal: "Normal",
  timeout: "Timeout",
  deep: "Deep",
};

function formatFocused(totalSeconds: number): string {
  if (totalSeconds < 60) return `${totalSeconds}s focused`;
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  if (hours > 0) return `${hours}h ${minutes}m focused`;
  return `${minutes}m focused`;
}

function FollowUpNote({ followUp }: { followUp: FocusFollowUpStatus | null }) {
  if (!followUp || followUp.kind === "none") return null;
  if (followUp.kind === "skipped") {
    return (
      <p className="mt-3 border-t border-border pt-3 text-[13px] leading-relaxed text-muted-foreground">
        {followUp.summary}
      </p>
    );
  }
  return (
    <div className="mt-3 border-t border-border pt-3 text-[13px]">
      <p className="leading-relaxed text-muted-foreground">{followUp.summary}</p>
      {followUp.runId ? (
        <a
          href={`/polymath/${followUp.runId}`}
          className="mt-1 inline-block underline underline-offset-4 hover:text-foreground"
        >
          Open the follow-up run
        </a>
      ) : null}
    </div>
  );
}

/** A closed session always has its end timestamp; the type keeps it nullable because the row does. */
export type ClosedSessionView = Omit<FocusSessionView, "endedAt"> & { endedAt: Date };

export function ClosedSummary({
  session,
  followUp,
}: {
  session: ClosedSessionView;
  followUp: FocusFollowUpStatus | null;
}) {
  const planned = session.plannedMinutes != null ? `${session.plannedMinutes} min planned` : null;
  return (
    <section className="panel min-w-0 rounded-xl p-4">
      <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-[13px] font-medium">{session.subject ?? "Focus session"}</h2>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            {tierLabels[session.strictness]} focus · {formatFocused(session.elapsedSeconds)}
            {planned ? ` · ${planned}` : ""} · ended {new Date(session.endedAt).toLocaleString()}
          </p>
        </div>
        <Status>{session.state === "finished" ? "Finished" : "Abandoned"}</Status>
      </div>
      {session.outcome || session.whatChanged || session.nextStep ? (
        <dl className="grid gap-2 border-t border-border pt-3 text-[13px]">
          {session.outcome ? (
            <div>
              <dt className="text-xs text-muted-foreground">Outcome</dt>
              <dd>{session.outcome}</dd>
            </div>
          ) : null}
          {session.whatChanged ? (
            <div>
              <dt className="text-xs text-muted-foreground">What changed</dt>
              <dd>{session.whatChanged}</dd>
            </div>
          ) : null}
          {session.nextStep ? (
            <div>
              <dt className="text-xs text-muted-foreground">Next step</dt>
              <dd>{session.nextStep}</dd>
            </div>
          ) : null}
        </dl>
      ) : null}
      <FollowUpNote followUp={followUp} />
    </section>
  );
}
