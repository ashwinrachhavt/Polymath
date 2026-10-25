import type { FocusSessionView } from "@/domains/focus/queries";

/*
 * One focus session on the timeline (ASH-308). A planned block sits dashed at
 * its slot with the capture's title; a started block spans its real time and
 * carries the live elapsed clock. Dismiss and start are wired by the timeline
 * (it owns the actions); the block is presentational.
 */
export type SessionBlockModel = {
  id: string;
  version: number;
  subject: string | null;
  kind: "planned" | "active" | "closed";
  /** Minutes since day start. */
  top: number;
  height: number;
  elapsedMinutes: number | null;
};

export function modelOf(session: FocusSessionView, dayStartMs: number, nowMs: number): SessionBlockModel | null {
  const MIN = 60_000;
  if (!session.startedAt && session.scheduledAt) {
    const slot = session.scheduledAt.getTime();
    return {
      id: session.id,
      version: session.version,
      subject: session.subject,
      kind: "planned",
      top: Math.max(0, (slot - dayStartMs) / MIN),
      // A planned block is a chip on the slot, not a span: the estimate is
      // unknown until the session runs.
      height: 45,
      elapsedMinutes: null,
    };
  }
  if (session.startedAt) {
    const start = session.startedAt.getTime();
    const end = session.endedAt ? session.endedAt.getTime() : nowMs;
    return {
      id: session.id,
      version: session.version,
      subject: session.subject,
      kind: session.state === "running" || session.state === "paused" ? "active" : "closed",
      top: Math.max(0, (start - dayStartMs) / MIN),
      height: Math.max(20, (end - start) / MIN),
      elapsedMinutes: Math.round(session.elapsedSeconds / 60),
    };
  }
  return null;
}

export function SessionBlock({
  model,
  onStart,
  onDismiss,
}: {
  model: SessionBlockModel;
  onStart?: (id: string, version: number) => void;
  onDismiss?: (id: string) => void;
}) {
  const base = "absolute right-2 left-14 overflow-hidden rounded-md border px-2 py-1 text-left";
  if (model.kind === "planned") {
    return (
      <div
        className={`${base} border-dashed border-app-accent/60 bg-app-accent/5`}
        style={{ top: model.top, minHeight: model.height }}
        data-testid={`planned-session-${model.id}`}
      >
        <div className="flex items-center justify-between gap-2">
          <p className="truncate text-[12px] font-medium">{model.subject ?? "Planned session"}</p>
          <div className="flex shrink-0 items-center gap-1">
            {onStart ? (
              <button
                type="button"
                className="rounded px-1.5 py-0.5 text-[11px] font-medium text-app-accent hover:bg-app-accent/10"
                onClick={() => onStart(model.id, model.version)}
              >
                Start
              </button>
            ) : null}
            {onDismiss ? (
              <button
                type="button"
                aria-label="Dismiss planned session"
                className="rounded px-1.5 py-0.5 text-[11px] text-foreground/80 hover:bg-muted"
                onClick={() => onDismiss(model.id)}
              >
                ×
              </button>
            ) : null}
          </div>
        </div>
        <p className="text-[11px] text-foreground/80">planned</p>
      </div>
    );
  }
  return (
    <div
      className={`${base} ${model.kind === "active" ? "border-app-accent bg-app-accent/10" : "border-border bg-muted/50"}`}
      style={{ top: model.top, minHeight: model.height }}
      data-testid={`session-${model.id}`}
    >
      <p className="truncate text-[12px] font-medium">{model.subject ?? "Focus session"}</p>
      <p className="text-[11px] text-foreground/80">
        {model.kind === "active" ? "in progress" : "finished"}
        {model.elapsedMinutes !== null ? ` · ${model.elapsedMinutes}m` : ""}
      </p>
    </div>
  );
}
