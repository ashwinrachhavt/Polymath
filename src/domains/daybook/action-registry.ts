/*
 * The audit actions a day page reads, in one constant. The day query filters
 * audit_events on this list, so a rename here fails compile there instead of
 * silently emptying a day section. Actions are grouped by the day section
 * that consumes them; adding a mutation without registering its action means
 * it does not appear on the day page.
 *
 * This module depends on audit_events staying unpruned (see queries.ts).
 * Agent and system activity is excluded at query time (actor_kind = 'user').
 */
export const DAYBOOK_ACTIONS = {
  created: ["note.created", "capture.created", "task.created", "event.time_blocked"],
  workedOn: ["note.snapshot", "note.ai.applied", "note.tags_changed", "note.renamed"],
  decided: [
    "task.completed",
    "capture.converted",
    "document.version_restored",
    "opportunity.stage_changed",
    "daybook.pin_added",
  ],
} as const;

export const DAYBOOK_ACTION_LIST: readonly string[] = Object.values(DAYBOOK_ACTIONS).flat();
