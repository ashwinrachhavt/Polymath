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
  /*
   * `note.created` is deliberately absent. The Created panel already lists the
   * artifact the event describes, so registering the event shows one note
   * creation twice - and a task is a note, which would make one task create
   * appear three times (artifact, note.created, task.created). A note is
   * recorded by the panel; only the mutations the panel cannot see are here.
   */
  created: ["capture.created", "task.created", "event.time_blocked"],
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
