/*
 * The stage vocabulary as a dependency-free leaf (same reason as
 * crm/status.ts): client stage selects need the labels without pulling the
 * db-backed query module into the browser bundle. The literals mirror the
 * `opportunity_stage` pgEnum; queries.ts re-exports them for server code.
 */
export const OPPORTUNITY_STAGES = [
  "identified",
  "researching",
  "preparing",
  "submitted",
  "interviewing",
  "negotiating",
  "won",
  "lost",
  "withdrawn",
] as const;
export type OpportunityStage = (typeof OPPORTUNITY_STAGES)[number];

export const STAGE_LABELS: Record<OpportunityStage, string> = {
  identified: "Identified",
  researching: "Researching",
  preparing: "Preparing",
  submitted: "Submitted",
  interviewing: "Interviewing",
  negotiating: "Negotiating",
  won: "Won",
  lost: "Lost",
  withdrawn: "Withdrawn",
};

/** The stages a pipeline view shows as columns; terminal outcomes are listed, not pipelined. */
export const PIPELINE_STAGES = OPPORTUNITY_STAGES.filter(
  (stage) => !["won", "lost", "withdrawn"].includes(stage),
);
