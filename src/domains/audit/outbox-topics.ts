/*
 * Topics whose events exist only to carry the audit row their producer wrote
 * in the same transaction: no consumer is ever required, so the dispatcher
 * completes them as a no-op instead of releasing them forever. Without this,
 * unhandled rows monopolize the head of every claim batch and starve real
 * work behind them (observed 2026-10-29: 48 handlerless rows kept capture
 * enrichment events unclaimed for hours). A topic here asserts the event's
 * content is fully recorded in audit_events; if user-visible state depends on
 * it, it needs a handler instead.
 */
export const AUDIT_ONLY_TOPICS: readonly string[] = [
  "actions.proposal.decided",
  "actions.proposal.revised",
  "agent_principal.registered",
  "agent_principal.status_changed",
  "delegation_grant.issued",
  "delegation_grant.revoked",
  "grant.created",
  "grant.revoked",
  "note.autosaved",
  "note.created",
  "note.renamed",
  "note.snapshot",
  "note.tags_changed",
  "research.company.completed",
  "research.profile.completed",
  "role.archived",
  "role.assigned",
  "role.defined",
  "role.revised",
  "role.unassigned",
  "task.created",
  "task.updated",
] as const;
