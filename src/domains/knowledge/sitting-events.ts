/*
 * The sitting creation-stream event protocol (plan 2026-10-29 §3, §15.2,
 * §15.9). SSE is a view, not the record: `token` and `thinking` stream live
 * to the connected client but are NEVER persisted - no transcripts on
 * reopen, the redaction problem eliminated. Durable persistence is the
 * allowlisted stage outcomes only, recorded as agent_steps payloads.
 *
 * Reconnect (§16.1): a new connection attaches to the run's durable events
 * only, via cursor replay of committed steps. There is no server-side
 * continuation across disconnects.
 */

export const SITTING_PROTOCOL_VERSION = 1 as const;

/** The stages the creation pipeline runs (§3); the panel renders these by name. */
export const CREATION_STAGES = ["embed", "links", "enrich", "bloom"] as const;

/**
 * §15.3 quota copy, verbatim — one shared string so the server event and the
 * ambient panel can never drift. Lives here (not sitting-run.ts) because the
 * panel is a client component and this module must stay dependency-free.
 */
export const QUOTA_UNAVAILABLE_MESSAGE =
  "Link discovery needs AI quota — your card is saved. Add credits or ask an admin to raise the quota, then retry indexing.";

/** The event families a client may receive (§3). */
export const SITTING_EVENTS = [
  "card_saved",
  "token",
  "thinking",
  "links_found",
  "enrichment",
  "bloom_suggested",
  "stage_started",
  "stage_completed",
  "stage_failed",
  "warning",
  "done",
  "error",
] as const;
export type SittingEventName = (typeof SITTING_EVENTS)[number];

/*
 * §15.2: the ONLY strings that may persist as a stage outcome in
 * agent_steps.payload. The event-schema test enumerates this list; anything
 * outside it must never reach the database.
 */
export const STAGE_OUTCOMES = [
  "saved",
  /^embedded:v\d+$/,
  /^links:\d+$/,
  "enriched",
  /^bloom:(1|2|3)$/,
  "skipped:edited",
  "skipped:busy",
  /^failed:.+$/,
] as const;

export function isAllowedStageOutcome(outcome: string): boolean {
  return STAGE_OUTCOMES.some((o) => (typeof o === "string" ? o === outcome : o.test(outcome)));
}

/** §15.2: every stage_failed carries {stage, code, message, operationId}. */
export type StageFailure = {
  stage: string;
  /** Stable machine code, e.g. QUOTA_UNAVAILABLE, PROVIDER_UNCONFIGURED. */
  code: string;
  /** One human sentence, rendered with a per-stage retry. */
  message: string;
  operationId: string;
};

export type SittingEvent = {
  protocolVersion: typeof SITTING_PROTOCOL_VERSION;
  /** The agent_runs id. */
  operationId: string;
  artifactId?: string;
  artifactVersionId?: string;
  event: SittingEventName;
  payload?: unknown;
};

/** NDJSON frame encoding: one event per line (§15.9 examples are NDJSON). */
export function encodeSittingEvent(event: SittingEvent): string {
  return `${JSON.stringify(event)}\n`;
}

/*
 * §15.9: credentials never appear in events, structured log lines or step
 * payloads. Events carry no secret-bearing fields by construction; this guard
 * is the test-pinned belt for a future payload that accidentally includes one.
 */
const CREDENTIAL_MARKERS = ["CLOUDFLARE_API_KEY", "OPENROUTER_API_KEY", "GEMINI_API_KEY", "authorization", "Bearer "] as const;

export function assertEventRedacted(event: SittingEvent): void {
  const serialized = JSON.stringify(event);
  for (const marker of CREDENTIAL_MARKERS) {
    if (serialized.includes(marker)) {
      throw new Error(`sitting event carries a credential marker: ${event.event}`);
    }
  }
}
