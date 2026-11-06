/*
 * The client-safe half of the triage seam (spec: Notifications Zero-Hop
 * Triage, §1). The panel is a client component: any runtime import from a
 * server module drags the database graph into the browser bundle, because
 * Turbopack traces the full import chain from the entry component. So the
 * contract — the item shapes and the classifier — lives here with no server
 * imports, and the server feed module re-exports it.
 */

import type { runState } from "@/domains/agents/schema";

/** The panel's tabs: what needs the owner, what is working, what already happened. */
export type TriageTab = "inbox" | "inFlight" | "activity";

export type RunState = (typeof runState.enumValues)[number];

/** Where a run sits for triage: still working, failed, or finished. */
export type TriageRunPhase = "active" | "failed" | "done";

// A cancelled run finished without failing: nothing to read or fix, so it is
// history (Activity), not Inbox. waiting_approval stays in flight — its
// blocking proposal already surfaces in the Inbox as a decision card.
const RUN_FAILED_STATES = new Set<RunState>(["failed"]);
const RUN_DONE_STATES = new Set<RunState>(["succeeded", "cancelled"]);

export function classifyRunState(state: RunState): TriageRunPhase {
  if (RUN_FAILED_STATES.has(state)) return "failed";
  if (RUN_DONE_STATES.has(state)) return "done";
  return "active";
}

export type TriageItem =
  | {
      kind: "question";
      /** The agent_questions row — the CAS target of reply and dismiss. */
      id: string;
      runId: string;
      questionText: string;
      /** The specific missing input the agent supplied, when it did. */
      context: string | null;
      askedAt: Date;
      href: string;
    }
  | {
      kind: "decision";
      /** The proposal id. */
      id: string;
      title: string;
      /** The exact effect approving has. */
      detail: string | null;
      href: string;
      at: Date;
      /** What one tap binds: an action approval binds the exact revision (CAS). */
      decision: { decisionType: "action"; revisionId: string; version: number; expired: boolean };
    }
  | {
      kind: "run";
      /** Equals runId, so every kind keys the same way. */
      id: string;
      runId: string;
      runState: RunState;
      /** The run surface's own word for the state, from RUN_STATE_LABEL. */
      stateLabel: string;
      title: string;
      /** The redacted failure detail; only failed runs carry one today. */
      detail: string | null;
      href: string;
      at: Date;
    };

export type TriageFeed = {
  items: TriageItem[];
  /** Per tab, so a tab header shows its own count without re-reading. */
  counts: Record<TriageTab, number>;
};

/** Which tab owns an item — the seam's classification, pinned by tests. */
export function triageTab(item: TriageItem): TriageTab {
  switch (item.kind) {
    case "question":
    case "decision":
      return "inbox";
    case "run":
      switch (item.runState) {
        case "failed":
          return "inbox";
        case "succeeded":
        case "cancelled":
          return "activity";
        case "queued":
        case "running":
        case "waiting_input":
        case "waiting_approval":
          return "inFlight";
        default: {
          const _exhaustive: never = item.runState;
          return _exhaustive;
        }
      }
  }
}
