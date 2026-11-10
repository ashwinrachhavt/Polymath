import { z } from "zod";

/*
 * The registry is the single source of truth for what an audit action means:
 * where it leads, whether it is feed-visible, how it is worded, and whether it
 * needs attention. The audit domain owns it (audit/README.md) because the
 * fail-closed summary policy already lived here - the registry extends that
 * policy, it does not replace it. scripts/check-audit-registry.ts enforces the
 * contract in CI: every emitted action must resolve to a definition here.
 *
 * Coverage is tiered:
 *
 * - Tier 1 - full definitions for every action on the legacy safe-summary
 *   allowlist (see queries.ts) plus every dynamic-family expansion. Each has a
 *   code-authored, em-dash-free sentence template and subject destinations.
 * - Tier 2 - per-domain technical defaults for every other emitted action:
 *   correct category, visibility "technical", the neutral sentence, subject
 *   destination only. They resolve through the registry so the presenter can
 *   show them as restricted technical events instead of improvising meaning.
 * - Unknown actions (future emitters, typos) resolve at the boundary to the
 *   generic technical default via resolveEventDefinition - never improvised
 *   from the raw string. The check script fails CI so the author registers it.
 *
 * Payload schemas model the metadata envelope, not per-action metadata keys:
 * rows written before payload versioning carry no version marker, and the
 * presenter (a later wave) parses raw metadata against these schemas
 * server-side only. Raw metadata never serializes to any client surface.
 */

export type EventCategory = "knowledge" | "work" | "agents" | "connections" | "workspace";
type EventVisibility = "activity" | "technical";
export type Attention = "none" | "in-progress" | "needs-action";
type OperationRole = "standalone" | "outcome" | "step";
type ActorKind = "user" | "system" | "agent";

export type ActorRef = { label: string; kind: ActorKind };
export type SubjectRef = { subjectType: string; subjectId: string | null };
export type Destination = { label: string; href: string } | { state: "unavailable"; reason: "deleted" | "restricted" };

/** The metadata envelope every event payload validates against, legacy rows included. */
export const eventPayloadSchema = z.object({ version: z.number().int().optional() }).passthrough();
type EventPayload = z.infer<typeof eventPayloadSchema>;

export type EventDefinition = {
  action: string;
  category: EventCategory;
  visibility: EventVisibility;
  /** Bumps when the metadata envelope contract changes; the presenter reads it. */
  payloadVersion: number;
  payload: z.ZodType;
  sentence: (payload: EventPayload, actor: ActorRef) => string;
  /** Route knowledge only; existence and authorization checks belong to the presenter. */
  destinations: (payload: EventPayload, subject: SubjectRef) => Destination | null;
  attention: Attention;
  grouping: { operation: OperationRole };
};

/**
 * Dynamic action families: the only template emits in the codebase, expanded
 * into explicit literals here so the registry never improvises meaning from
 * an arbitrary string. Each suffix list is the full value space of the
 * emitting variable, verified against its source union:
 * integration.account_${status} - setAccountStatus's "active"|"expired"|"revoked"|"error"
 * (src/domains/integrations/commands.ts); run.feedback.${value} -
 * MessageFeedback "up"|"down" plus the cleared branch
 * (src/domains/agents/feedback.ts, run-reviews.ts); follow_up.${resolution} -
 * "done"|"cancelled" (src/domains/crm/commands.ts).
 */
export const DYNAMIC_FAMILIES: Record<string, string[]> = {
  "integration.account_": ["active", "expired", "revoked", "error"],
  "run.feedback.": ["up", "down", "cleared"],
  "follow_up.": ["done", "cancelled"],
};

/** The sentence Tier 2 and unknown actions render: carries no stored content. */
export const GENERIC_TECHNICAL_SUMMARY = "Workspace activity recorded";

/*
 * Subject destinations from the verified route table. This is deliberately
 * exhaustive-only: a subject type with an ambiguous route (subjectType
 * "artifact" covers notes, documents and wiki pages alike) or no per-entity
 * route gets null - no link beats a wrong link. The presenter resolves
 * existence and authorization per domain before any href is shown.
 */
const SUBJECT_ROUTES: Record<string, (subjectId: string) => Destination> = {
  capture: (id) => ({ label: "Open capture", href: `/command-center/inbox?id=${id}` }),
  task: (id) => ({ label: "Open task", href: `/neuralflow/work?task=${id}` }),
  contact: (id) => ({ label: "Open contact", href: `/command-center/relationships/people?id=${id}` }),
  company: (id) => ({ label: "Open company", href: `/command-center/relationships/companies/${id}` }),
  document: (id) => ({ label: "Open document", href: `/polymath/knowledge?doc=${id}` }),
  run: (id) => ({ label: "Open run", href: `/polymath/${id}` }),
};

/** Connector accounts have no per-connection route; the settings surface is the destination. */
const INTEGRATIONS_DESTINATION: Destination = { label: "Integration settings", href: "/command-center/integrations" };

export function subjectDestination(subject: SubjectRef): Destination | null {
  if (subject.subjectType === "external_account") return INTEGRATIONS_DESTINATION;
  const route = SUBJECT_ROUTES[subject.subjectType];
  if (!route || !subject.subjectId) return null;
  return route(subject.subjectId);
}

/** Actor-aware sentence: the presenter hydrates labels ("You", display names, "Polymath"). */
function actorSentence(actor: ActorRef, verbPhrase: string): string {
  return `${actor.label} ${verbPhrase}`;
}

/*
 * Tier 1: category, code-authored verb phrase, and the operation role for
 * every allowlisted action plus every dynamic-family expansion. Destinations
 * resolve from the subject routes; conversion-result destinations (payload
 * result refs) arrive with the conversion payload wave.
 */

/*
 * The conversion payload envelope (payload v1, the audit design's
 * write-boundary section): what a conversion row carries so the presenter can make the
 * outcome navigable without the stored summary naming a title. Rows written
 * before payload versioning carry no version marker and never parse as v1,
 * so they render through the legacy allowlist path. The writer wave and the
 * presenter code against this one schema; the presenter tests pin it with
 * fixtures.
 */
const conversionPayloadSchema = z.object({
  version: z.literal(1),
  resultType: z.string(),
  resultId: z.string().uuid(),
  displaySnapshot: z.object({ title: z.string() }).optional(),
});
export type ConversionPayload = z.infer<typeof conversionPayloadSchema>;

/** Null when the metadata is not a v1 conversion payload (legacy rows included). */
export function parseConversionPayload(metadata: unknown): ConversionPayload | null {
  const parsed = conversionPayloadSchema.safeParse(metadata);
  return parsed.success ? parsed.data : null;
}

/*
 * Result destinations: where a conversion's outcome lives. "draft" routes
 * with "note" because a draft conversion creates a note artifact
 * (createNoteInTx in capture/commands.ts). An unknown resultType resolves to
 * null - no link beats a wrong link, the same rule the subject routes follow.
 */
const RESULT_ROUTES: Record<string, (resultId: string) => Destination> = {
  note: (id) => ({ label: "Open note", href: `/polymath/notes?id=${id}` }),
  draft: (id) => ({ label: "Open note", href: `/polymath/notes?id=${id}` }),
  task: (id) => ({ label: "Open task", href: `/neuralflow/work?task=${id}` }),
  document: (id) => ({ label: "Open document", href: `/polymath/knowledge?doc=${id}` }),
};

export function conversionResultDestination(payload: ConversionPayload): Destination | null {
  const route = RESULT_ROUTES[payload.resultType];
  return route ? route(payload.resultId) : null;
}

type Tier1Spec = {
  action: string;
  category: EventCategory;
  verbPhrase: string;
  operation?: OperationRole;
};

const TIER_1: Tier1Spec[] = [
  // Calendar (member-visible calendar surfaces).
  { action: "event.created", category: "work", verbPhrase: "created an event" },
  { action: "event.time_blocked", category: "work", verbPhrase: "blocked time on the calendar" },
  { action: "event.follow_up_created", category: "work", verbPhrase: "created a follow-up from an event" },
  { action: "event.moved", category: "work", verbPhrase: "moved an event" },
  { action: "event.cancelled", category: "work", verbPhrase: "cancelled an event" },
  // Opportunities (member-visible opportunities surface).
  { action: "opportunity.created", category: "work", verbPhrase: "created an opportunity" },
  { action: "opportunity.updated", category: "work", verbPhrase: "updated an opportunity" },
  { action: "opportunity.stage_changed", category: "work", verbPhrase: "changed an opportunity stage" },
  { action: "opportunity.archived", category: "work", verbPhrase: "archived an opportunity" },
  { action: "opportunity.deadline_added", category: "work", verbPhrase: "added an opportunity deadline" },
  { action: "opportunity.deadline_met", category: "work", verbPhrase: "marked an opportunity deadline met" },
  // Integrations (member-visible integrations settings).
  { action: "integration.google_calendar_synced", category: "connections", verbPhrase: "synced Google Calendar" },
  {
    action: "integration.connection_started",
    category: "connections",
    verbPhrase: "started connecting an integration",
  },
  {
    action: "integration.connection_completed",
    category: "connections",
    verbPhrase: "completed an integration connection",
  },
  { action: "integration.connection_failed", category: "connections", verbPhrase: "failed to connect an integration" },
  { action: "integration.account_registered", category: "connections", verbPhrase: "registered a connector account" },
  { action: "integration.account_tier_set", category: "connections", verbPhrase: "set a connector account tier" },
  {
    action: "integration.account_capability_set",
    category: "connections",
    verbPhrase: "changed connector account capabilities",
  },
  { action: "integration.account_renamed", category: "connections", verbPhrase: "renamed a connector account" },
  { action: "integration.account_active", category: "connections", verbPhrase: "reconnected a connector account" },
  {
    action: "integration.account_expired",
    category: "connections",
    verbPhrase: "reported a connector account expired",
  },
  { action: "integration.account_revoked", category: "connections", verbPhrase: "revoked a connector account" },
  { action: "integration.account_error", category: "connections", verbPhrase: "reported a connector account error" },
  { action: "integration.write_default_set", category: "connections", verbPhrase: "set an integration write default" },
  // Daybook (dates and counts only, never entry text).
  { action: "daybook.pin_added", category: "work", verbPhrase: "pinned a daybook entry" },
  { action: "daybook.pin_removed", category: "work", verbPhrase: "unpinned a daybook entry" },
  { action: "daybook.shutdown", category: "work", verbPhrase: "closed out the daybook" },
  // Capture inbox (member-visible inbox; stored summaries name kinds, filenames
  // and workspace-entity titles, never body text).
  { action: "capture.created", category: "knowledge", verbPhrase: "added a capture" },
  { action: "capture.edited", category: "knowledge", verbPhrase: "edited a capture" },
  { action: "capture.parked", category: "knowledge", verbPhrase: "parked a capture" },
  { action: "capture.unparked", category: "knowledge", verbPhrase: "unparked a capture" },
  { action: "capture.archived", category: "knowledge", verbPhrase: "archived a capture" },
  { action: "capture.restored", category: "knowledge", verbPhrase: "restored a capture" },
  { action: "capture.converted", category: "knowledge", verbPhrase: "converted a capture", operation: "outcome" },
  {
    action: "capture.zettels_created",
    category: "knowledge",
    verbPhrase: "created ideas from a capture",
    operation: "step",
  },
  { action: "capture.transcribed", category: "knowledge", verbPhrase: "transcribed a voice capture" },
  // Ideas (direct creation: the triggering click is the permission, so the
  // pass writes the card and the audit row together. Accept and reject were
  // review decisions; both actions are gone with the proposal layer they
  // decided).
  {
    action: "zettel.created",
    category: "knowledge",
    verbPhrase: "added an idea to the library",
    operation: "step",
  },
  {
    action: "zettel.duplicate_skipped",
    category: "knowledge",
    verbPhrase: "skipped a duplicate idea",
    operation: "step",
  },
  {
    action: "zettel.evidence_linked",
    category: "knowledge",
    verbPhrase: "linked new evidence to an idea",
    operation: "step",
  },
  {
    action: "artifact.feedback_recorded",
    category: "knowledge",
    verbPhrase: "rated an artifact",
    operation: "step",
  },
  // Run feedback (dynamic family: the owner's like/dislike on a run's reply).
  { action: "run.feedback.up", category: "agents", verbPhrase: "gave a run positive feedback" },
  { action: "run.feedback.down", category: "agents", verbPhrase: "gave a run negative feedback" },
  { action: "run.feedback.cleared", category: "agents", verbPhrase: "cleared run feedback" },
  // Follow-up resolutions (dynamic family).
  { action: "follow_up.done", category: "work", verbPhrase: "resolved a follow-up" },
  { action: "follow_up.cancelled", category: "work", verbPhrase: "cancelled a follow-up" },
  // Workspace-level lifecycle and proposals.
  { action: "inventory.imported", category: "workspace", verbPhrase: "imported inventory" },
  { action: "onboarding.completed", category: "workspace", verbPhrase: "completed onboarding" },
  { action: "onboarding.assisted", category: "workspace", verbPhrase: "assisted onboarding" },
  { action: "spending_policy.created", category: "work", verbPhrase: "created a spending policy" },
  { action: "meeting.debriefed", category: "knowledge", verbPhrase: "debriefed a meeting" },
  { action: "note.snapshot", category: "knowledge", verbPhrase: "saved a note snapshot" },
];

/*
 * Tier 2: every other emitted action, as explicit per-action defaults. The
 * category is curated per entry (not derived from the action's first
 * segment, which misleads: crm.* is the CRM surface's settings, api_client.*
 * is workspace security). These stay visibility "technical" - a later wave
 * promotes individual actions after their copy and destinations are designed,
 * mirroring how the legacy allowlist grew deliberately.
 */
const TIER_2_ACTIONS: { action: string; category: EventCategory }[] = [
  { action: "actions.effect_failed", category: "agents" },
  { action: "actions.effect_reconciled", category: "agents" },
  { action: "actions.effect_sent", category: "agents" },
  { action: "actions.effect_unknown", category: "agents" },
  { action: "actions.proposal_decided", category: "agents" },
  { action: "actions.proposal_revised", category: "agents" },
  { action: "agent_principal.registered", category: "agents" },
  { action: "agent_principal.status_changed", category: "agents" },
  { action: "agent_profile.brief_saved", category: "agents" },
  { action: "agents.external_session_imported", category: "agents" },
  { action: "api_client.created", category: "workspace" },
  { action: "api_client.revoked", category: "workspace" },
  { action: "artifact.revision.approved", category: "knowledge" },
  { action: "briefing_seed.committed", category: "work" },
  { action: "briefing_seed.dismissed", category: "work" },
  { action: "capture.extracted", category: "knowledge" },
  { action: "capture.url_retry_requested", category: "knowledge" },
  { action: "company.created", category: "work" },
  { action: "company.created_from_document", category: "work" },
  { action: "company.merged", category: "work" },
  { action: "contact.archived", category: "work" },
  { action: "contact.created", category: "work" },
  { action: "contact.created_from_document", category: "work" },
  { action: "contact.merged", category: "work" },
  { action: "contact.observation_added", category: "work" },
  { action: "contact.updated", category: "work" },
  { action: "conversation.created", category: "agents" },
  { action: "conversation.navigation_answered", category: "agents" },
  { action: "correspondence.cancelled", category: "work" },
  { action: "correspondence.drafted", category: "work" },
  { action: "correspondence.edited", category: "work" },
  { action: "correspondence.send_failed", category: "work" },
  { action: "correspondence.send_reconciled_absent", category: "work" },
  { action: "correspondence.send_reconciled_sent", category: "work" },
  { action: "correspondence.send_requested", category: "work" },
  { action: "correspondence.send_unknown", category: "work" },
  { action: "correspondence.sent", category: "work" },
  { action: "crm.sender_proposals_enabled", category: "work" },
  { action: "crm.sender_proposals_paused", category: "work" },
  { action: "delegation_grant.issued", category: "work" },
  { action: "delegation_grant.revoked", category: "work" },
  { action: "document.archived", category: "knowledge" },
  { action: "document.classified", category: "knowledge" },
  { action: "document.export_packet_assembled", category: "knowledge" },
  { action: "document.read_finished", category: "knowledge" },
  { action: "document.tagged", category: "knowledge" },
  { action: "document.version_restored", category: "knowledge" },
  { action: "document_export.created", category: "knowledge" },
  { action: "document_folder.archived", category: "knowledge" },
  { action: "document_folder.created", category: "knowledge" },
  { action: "document_folder.moved", category: "knowledge" },
  { action: "document_folder.renamed", category: "knowledge" },
  { action: "draft.edited", category: "knowledge" },
  { action: "draft.record.linked", category: "knowledge" },
  { action: "draft.record.unlinked", category: "knowledge" },
  // Studio draft decisions (save/discard) - exposed to the scanner when the
  // decide() helper migrated onto recordAudit with inline literals.
  { action: "draft.saved", category: "knowledge" },
  { action: "draft.discarded", category: "knowledge" },
  { action: "field_proposal.accepted", category: "work" },
  { action: "field_proposal.deferred", category: "work" },
  { action: "field_proposal.rejected", category: "work" },
  { action: "file.captured", category: "knowledge" },
  { action: "file.crawled", category: "knowledge" },
  { action: "file.quarantined", category: "knowledge" },
  { action: "file.transcribed", category: "knowledge" },
  { action: "file.uploaded", category: "knowledge" },
  { action: "focus.follow_up_skipped", category: "work" },
  { action: "focus.follow_up_started", category: "work" },
  { action: "focus.session_scheduled", category: "work" },
  { action: "focus.session_unscheduled", category: "work" },
  { action: "focus_session.abandon_requested", category: "work" },
  { action: "focus_session.abandoned", category: "work" },
  { action: "focus_session.finished", category: "work" },
  { action: "focus_session.paused", category: "work" },
  { action: "focus_session.resumed", category: "work" },
  { action: "focus_session.started", category: "work" },
  { action: "follow_up.created", category: "work" },
  { action: "grant.created", category: "work" },
  { action: "grant.revoked", category: "work" },
  { action: "integration.notion_synced", category: "connections" },
  { action: "invitation.accepted", category: "workspace" },
  { action: "invitation.created", category: "workspace" },
  { action: "invitation.revoked", category: "workspace" },
  { action: "knowledge.design_brief.generated", category: "knowledge" },
  { action: "learning.flashcard_reviewed", category: "knowledge" },
  { action: "learning.flashcards_generated", category: "knowledge" },
  { action: "learning.artifact_feedback_recorded", category: "knowledge" },
  { action: "learning.graph_recall_attempted", category: "knowledge" },
  { action: "learning.explain_answer_submitted", category: "knowledge" },
  { action: "learning.explain_session_started", category: "knowledge" },
  { action: "learning.quiz_completed", category: "knowledge" },
  { action: "learning.quiz_generated", category: "knowledge" },
  { action: "meeting.prep_generated", category: "knowledge" },
  { action: "membership.changed", category: "workspace" },
  { action: "message.comment_added", category: "agents" },
  { action: "message.comment_reopened", category: "agents" },
  { action: "message.comment_resolved", category: "agents" },
  { action: "note.ai.applied", category: "knowledge" },
  { action: "note.comment_added", category: "knowledge" },
  { action: "note.comment_reopened", category: "knowledge" },
  { action: "note.comment_resolved", category: "knowledge" },
  { action: "note.created", category: "knowledge" },
  { action: "note.renamed", category: "knowledge" },
  { action: "note.saved_from_answer", category: "knowledge" },
  { action: "note.tags_changed", category: "knowledge" },
  { action: "obligation.accepted", category: "knowledge" },
  { action: "parties.imported", category: "work" },
  { action: "parties.seeded", category: "work" },
  { action: "personal_seed.imported", category: "work" },
  { action: "policy.sender_aliases_set", category: "workspace" },
  { action: "preferences.saved", category: "workspace" },
  { action: "proposal.created", category: "work" },
  { action: "proposal.revised", category: "work" },
  { action: "rate_card.created", category: "work" },
  { action: "reading_summary.accepted", category: "knowledge" },
  { action: "research.company.completed", category: "knowledge" },
  { action: "research.profile.completed", category: "knowledge" },
  { action: "reward.awarded", category: "work" },
  { action: "reward.reversed", category: "work" },
  { action: "reward.shard_claimed", category: "work" },
  { action: "reward_definition.created", category: "work" },
  { action: "reward_definition.updated", category: "work" },
  { action: "role.archived", category: "workspace" },
  { action: "role.assigned", category: "workspace" },
  { action: "role.defined", category: "workspace" },
  { action: "role.revised", category: "workspace" },
  { action: "role.unassigned", category: "workspace" },
  { action: "run.critique.created", category: "agents" },
  { action: "run.critique.dismissed", category: "agents" },
  { action: "skill.disabled", category: "workspace" },
  { action: "skill.enabled", category: "workspace" },
  { action: "skill.installed", category: "workspace" },
  { action: "skill.removed", category: "workspace" },
  { action: "spending_policy.updated", category: "work" },
  { action: "task.completed", category: "work" },
  { action: "task.created", category: "work" },
  { action: "task.dependency_added", category: "work" },
  { action: "task.dependency_removed", category: "work" },
  { action: "task.moved", category: "work" },
  { action: "task.reopened", category: "work" },
  { action: "task.subtask_created", category: "work" },
  { action: "task.updated", category: "work" },
  { action: "task.waiting_on_added", category: "work" },
  { action: "workspace.created", category: "workspace" },
  { action: "wiki.article_ingested", category: "knowledge" },
  { action: "wiki.article_updated", category: "knowledge" },
  { action: "writing.library_drafted", category: "knowledge" },
];

function tier2Definition(action: string, category: EventCategory): EventDefinition {
  return {
    action,
    category,
    visibility: "technical",
    payloadVersion: 1,
    payload: eventPayloadSchema,
    sentence: () => GENERIC_TECHNICAL_SUMMARY,
    destinations: (_payload, subject) => subjectDestination(subject),
    attention: "none",
    grouping: { operation: "standalone" },
  };
}

function tier1Definition(spec: Tier1Spec): EventDefinition {
  return {
    action: spec.action,
    category: spec.category,
    visibility: "activity",
    payloadVersion: 1,
    payload: eventPayloadSchema,
    sentence: (_payload, actor) => actorSentence(actor, spec.verbPhrase),
    destinations: (_payload, subject) => subjectDestination(subject),
    attention: "none",
    grouping: { operation: spec.operation ?? "standalone" },
  };
}

const REGISTRY = new Map<string, EventDefinition>();
for (const spec of TIER_1) REGISTRY.set(spec.action, tier1Definition(spec));
for (const entry of TIER_2_ACTIONS) REGISTRY.set(entry.action, tier2Definition(entry.action, entry.category));

export function isRegisteredAction(action: string): boolean {
  return REGISTRY.has(action);
}

export function registeredActions(): string[] {
  return [...REGISTRY.keys()];
}

/**
 * Resolve an action to its definition. Registered actions resolve exactly;
 * anything else resolves to the generic technical default (never improvised
 * from the raw string) so a read-side consumer cannot crash on, or leak, an
 * unregistered action. The check script keeps the two in step: unregistered
 * actions fail CI.
 */
export function resolveEventDefinition(action: string): EventDefinition {
  const defined = REGISTRY.get(action);
  if (defined) return defined;
  return tier2Definition(action, "workspace");
}

/*
 * Filter vocabularies for the read model, derived from the registry once at
 * module load. A SQL WHERE cannot call the registry, so the read model
 * filters by `action IN (...)` over these lists: an unknown action appears in
 * neither (it is technical by default, per resolveEventDefinition), so the
 * feed hides it unless the viewer asks for technical events.
 */
const ACTIONS_BY_CATEGORY = new Map<EventCategory, string[]>();
const ACTIVITY_VISIBLE_ACTIONS: string[] = [];
for (const [action, definition] of REGISTRY) {
  const inCategory = ACTIONS_BY_CATEGORY.get(definition.category);
  if (inCategory) inCategory.push(action);
  else ACTIONS_BY_CATEGORY.set(definition.category, [action]);
  if (definition.visibility === "activity") ACTIVITY_VISIBLE_ACTIONS.push(action);
}

/** Actions with feed-visible definitions; the Activity page's default set. */
export function activityVisibleActions(): readonly string[] {
  return ACTIVITY_VISIBLE_ACTIONS;
}

/** Registered actions in one category, for the Activity page's category filter. */
export function actionsInCategory(category: EventCategory): readonly string[] {
  return ACTIONS_BY_CATEGORY.get(category) ?? [];
}
