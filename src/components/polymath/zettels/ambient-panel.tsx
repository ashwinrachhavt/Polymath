"use client";

import type { StreamState } from "./creation-stream-reducer";

/*
 * The AmbientIntelligencePanel states (§14.4): resting hint, live stages,
 * per-stage failure with its retry, and the exact §15.3 quota copy for the
 * UNAVAILABLE state.
 */
export function AmbientPanel({
  state,
  onRetryStage,
}: {
  state: StreamState;
  onRetryStage: (stage: string) => void;
}) {
  const stageNames = ["embed", "links", "enrich"];
  const anyActivity = state.saved || Object.keys(state.stages).length > 0;
  const quotaFailed = Object.values(state.stages).some(
    (s) => s.status === "failed" && s.failure?.code === "QUOTA_UNAVAILABLE",
  );
  return (
    <aside aria-live="polite" className="flex w-72 shrink-0 flex-col gap-3 border-l border-border p-4 max-lg:border-l-0 max-lg:border-t">
      <h2 className="font-mono text-xs uppercase tracking-wide text-muted-foreground">Ambient</h2>
      {!anyActivity && !state.done && (
        <p className="text-sm text-muted-foreground">Assistance starts when you pause</p>
      )}
      {state.live.thinking && (
        <p className="text-sm italic text-muted-foreground">{state.live.thinking}</p>
      )}
      {state.live.tokens && (
        <p className="whitespace-pre-wrap text-sm">{state.live.tokens}</p>
      )}
      {stageNames.map((name) => {
        const stage = state.stages[name];
        if (!stage || stage.status === "idle") return null;
        return (
          <div key={name} className="rounded border border-border px-3 py-2 text-sm">
            <span className="font-mono text-xs">{name}</span>{" "}
            {stage.status === "running" && <span className="text-muted-foreground">working…</span>}
            {stage.status === "done" && <span className="text-muted-foreground">{stage.outcome}</span>}
            {stage.status === "failed" && (
              <span>
                <span className="text-destructive">{stage.failure?.message}</span>{" "}
                <button className="underline" onClick={() => onRetryStage(name)}>Retry</button>
              </span>
            )}
          </div>
        );
      })}
      {quotaFailed && (
        <p className="text-sm text-muted-foreground">
          Link discovery needs AI quota — your card is saved. Add credits or ask an admin to raise the quota, then retry indexing.
        </p>
      )}
      {state.linksFound !== null && state.linksFound > 0 && (
        <p className="text-sm">{state.linksFound} related card{state.linksFound === 1 ? "" : "s"} surfaced</p>
      )}
      {state.error && <p className="text-sm text-destructive">{state.error.message}</p>}
    </aside>
  );
}
