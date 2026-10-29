import type { SittingEvent } from "@/domains/knowledge/sitting-events";

/*
 * The WritingSurface's stream-event handling, as a pure reducer so the
 * component stays presentational (plan §7). The load-bearing guards live
 * here, each pinned by §11's adversarial list:
 * - events from a DIFFERENT run never apply (sitting switch while old
 *   events arrive: a late stream cannot mutate the open sitting);
 * - token/thinking apply only to the version the run proposed against
 *   (§7: AI suggestions are version-bound proposals);
 * - one stage's failure leaves siblings' state untouched (§14.4).
 */

export type StageStatus = "idle" | "running" | "done" | "failed";
export type StageState = {
  status: StageStatus;
  outcome?: string;
  failure?: { stage: string; code: string; message: string; operationId: string };
};

export type StreamState = {
  sittingId: string;
  operationId: string | null;
  artifactId: string | null;
  artifactVersionId: string | null;
  saved: boolean;
  savedVersionNumber: number | null;
  stages: Record<string, StageState>;
  /** Live, uncommitted: thinking + streamed tokens for the current pause. */
  live: { thinking: string; tokens: string };
  /** The run's committed suggestion, a proposal bound to artifactVersionId. */
  proposal: { suggestion: string; artifactVersionId: string | null } | null;
  linksFound: number | null;
  done: boolean;
  error: { code: string; message: string } | null;
};

export function initialStreamState(sittingId: string): StreamState {
  return {
    sittingId,
    operationId: null,
    artifactId: null,
    artifactVersionId: null,
    saved: false,
    savedVersionNumber: null,
    stages: {},
    live: { thinking: "", tokens: "" },
    proposal: null,
    linksFound: null,
    done: false,
    error: null,
  };
}

function stage(state: StreamState, name: string): StageState {
  return state.stages[name] ?? { status: "idle" };
}

export function reduceStreamEvent(state: StreamState, event: SittingEvent): StreamState {
  // §11: a late event from a run that is not this panel's run never applies.
  if (state.operationId !== null && event.operationId !== state.operationId) return state;
  const withRun = state.operationId === null && event.operationId
    ? { ...state, operationId: event.operationId }
    : state;

  switch (event.event) {
    case "card_saved": {
      const payload = (event.payload ?? {}) as { versionNumber?: number };
      return {
        ...withRun,
        saved: true,
        artifactId: event.artifactId ?? withRun.artifactId,
        artifactVersionId: event.artifactVersionId ?? withRun.artifactVersionId,
        savedVersionNumber: payload.versionNumber ?? withRun.savedVersionNumber,
      };
    }
    case "stage_started": {
      const { stage: name } = (event.payload ?? {}) as { stage: string };
      return { ...withRun, stages: { ...withRun.stages, [name]: { status: "running" } } };
    }
    case "stage_completed": {
      const { stage: name, outcome } = (event.payload ?? {}) as { stage: string; outcome?: string };
      return { ...withRun, stages: { ...withRun.stages, [name]: { status: "done", outcome } } };
    }
    case "stage_failed": {
      const failure = (event.payload ?? {}) as StageState["failure"] & object;
      // Siblings untouched: only the failed stage's entry changes (§14.4).
      return { ...withRun, stages: { ...withRun.stages, [failure.stage]: { status: "failed", failure } } };
    }
    case "thinking": {
      if (event.artifactVersionId && withRun.artifactVersionId && event.artifactVersionId !== withRun.artifactVersionId) return state;
      const { content } = (event.payload ?? {}) as { content?: string };
      return { ...withRun, live: { ...withRun.live, thinking: withRun.live.thinking + (content ?? "") } };
    }
    case "token": {
      if (event.artifactVersionId && withRun.artifactVersionId && event.artifactVersionId !== withRun.artifactVersionId) return state;
      const { content } = (event.payload ?? {}) as { content?: string };
      return { ...withRun, live: { ...withRun.live, tokens: withRun.live.tokens + (content ?? "") } };
    }
    case "links_found": {
      const { candidates } = (event.payload ?? {}) as { candidates?: number };
      return { ...withRun, linksFound: candidates ?? 0 };
    }
    case "enrichment": {
      const { suggestion } = (event.payload ?? {}) as { suggestion?: string };
      return {
        ...withRun,
        proposal: {
          suggestion: suggestion ?? withRun.live.tokens,
          artifactVersionId: event.artifactVersionId ?? withRun.artifactVersionId,
        },
      };
    }
    case "bloom_suggested":
      // v1: Bloom dots are inert (§14.12); the event is accepted and ignored.
      return withRun;
    case "warning":
      return withRun;
    case "done":
      return { ...withRun, done: true };
    case "error": {
      const { code, message } = (event.payload ?? {}) as { code?: string; message?: string };
      return { ...withRun, error: { code: code ?? "RUN_FAILED", message: message ?? "The sitting run failed - your writing is saved." } };
    }
  }
}
