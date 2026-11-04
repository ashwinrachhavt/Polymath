import { and, eq, inArray } from "drizzle-orm";
import { getAgentPrincipalLabels, getRun } from "@/domains/agents/queries";
import { getCapture } from "@/domains/capture/queries";
import { getCompanyDetail, getContactDetail } from "@/domains/crm/queries";
import { getUserDisplayNames } from "@/domains/identity/members";
import type { AuthContext } from "@/domains/identity/resolve";
import { getDocumentTitle } from "@/domains/knowledge/documents";
import { getNote } from "@/domains/knowledge/notes";
import { getTaskDetail } from "@/domains/work/queries";
import { db } from "@/lib/db";
import {
  conversionResultDestination,
  eventPayloadSchema,
  parseConversionPayload,
  resolveEventDefinition,
  type ActorRef,
  type Attention,
  type Destination,
  type EventCategory,
  type EventDefinition,
} from "./events/registry";
import { genericSummary, isSafeSummaryAction, sanitizeSummary, type ActivityEventRow } from "./queries";
import { auditEvents } from "./schema";

/* Consumers project through this module only, so they name its types. */
export type { Destination };

/*
 * The single consumer-visible projection over audit rows (spec section 4):
 * both the Activity page and the notifications feed render this, and nothing
 * else does. Raw metadata is read here and only here - loaded inside the
 * audit domain, parsed against registry schemas, and discarded; only
 * registry-defined fields (a destination, a snapshot title) survive into an
 * ActivityItem. Raw metadata never serializes to any client surface.
 *
 * Sentence selection keeps the fail-closed ladder, widest first:
 *
 * - payload version 1, envelope-valid: the registry's code-authored template
 *   ("You converted a capture").
 * - legacy row on the safe-summary allowlist: the stored summary through
 *   sanitizeSummary - the exact policy listWorkspaceActivity enforced, moved
 *   behind this projection.
 * - anything else: genericSummary(action), a humanized constant name that
 *   carries no stored content.
 *
 * Destinations resolve post-authorization by composing the existing
 * per-domain workspace-scoped getters. The registry owns route knowledge; a
 * getter miss means the entity is provably gone within the workspace scope,
 * and the item renders an honest "unavailable" instead of a dead href.
 */

export type ActivityItem = {
  id: string;
  occurredAt: Date;
  category: EventCategory;
  sentence: string;
  title: string | null;
  actor: ActorRef;
  primary: Destination | null;
  related: Destination[];
  steps: string[];
  attention: Attention;
  technical: { action: string; subjectType: string; subjectId: string | null; operationId: string | null };
};

/**
 * Actor attribution, viewer-aware: the viewer's own row reads "You"; a user
 * actor reads the batch-hydrated display name with a neutral fallback; an
 * agent reads the workspace's principal label or "Agent"; system reads
 * "Polymath". The hydration maps arrive batched per page, never per row.
 */
export function resolveActorRef(
  row: Pick<ActivityEventRow, "actorId" | "actorKind">,
  viewerId: string,
  userNames: Map<string, string | null>,
  agentLabels: Map<string, string>,
): ActorRef {
  if (row.actorKind === "system") return { label: "Polymath", kind: "system" };
  if (row.actorKind === "agent") {
    const label = row.actorId ? agentLabels.get(row.actorId) : undefined;
    return { label: label ?? "Agent", kind: "agent" };
  }
  if (row.actorId && row.actorId === viewerId) return { label: "You", kind: "user" };
  const name = row.actorId ? userNames.get(row.actorId)?.trim() : undefined;
  return { label: name || "Workspace member", kind: "user" };
}

/**
 * Sentence selection, the fail-closed ladder. A payload-version match renders
 * the registry template; a legacy row renders its stored summary only through
 * the allowlist (sanitizeSummary included, verbatim); everything else renders
 * the humanized constant name, which carries no stored content. A future
 * payload-version bump fails the version check and falls back - it never
 * renders through assumptions written for v1.
 */
export function selectSentence(
  row: Pick<ActivityEventRow, "action" | "summary">,
  metadata: unknown,
  actor: ActorRef,
): string {
  const definition = resolveEventDefinition(row.action);
  const envelope = eventPayloadSchema.safeParse(metadata ?? {});
  if (envelope.success && envelope.data.version === definition.payloadVersion) {
    return definition.sentence(envelope.data, actor);
  }
  if (isSafeSummaryAction(row.action)) return sanitizeSummary(row.action, row.summary);
  return genericSummary(row.action);
}

export type OperationPlan = { outcome: ActivityEventRow; steps: ActivityEventRow[] };

/**
 * Collapse operation rows: the rows sharing an operationId fold into their
 * registry-designated outcome, with the steps ordered oldest-first for the
 * disclosure. A group with no outcome row on this page collapses to nothing -
 * every row renders standalone - because hiding a step row whose outcome
 * paginated onto another page would make the feed lie about what happened.
 */
export function planOperationGroups(rows: ActivityEventRow[]): Map<string, OperationPlan> {
  const byOperation = new Map<string, ActivityEventRow[]>();
  for (const row of rows) {
    if (!row.operationId) continue;
    const group = byOperation.get(row.operationId);
    if (group) group.push(row);
    else byOperation.set(row.operationId, [row]);
  }
  const plans = new Map<string, OperationPlan>();
  for (const [operationId, groupRows] of byOperation) {
    const outcome = groupRows.find((row) => resolveEventDefinition(row.action).grouping.operation === "outcome");
    if (!outcome) continue;
    plans.set(operationId, { outcome, steps: groupRows.filter((row) => row.id !== outcome.id).reverse() });
  }
  return plans;
}

/** What an entity check learns: a hit with the live title, or a miss. */
type EntityView = { title: string | null } | null;
type EntityLookup = (auth: AuthContext, id: string) => Promise<EntityView>;

/*
 * The destination checks, one per routed entity type: the existing
 * per-domain workspace-scoped getters, composed per the convention rather
 * than any invented shared guard. A miss is provable within the workspace
 * scope, so it renders reason "deleted"; "restricted" stays in the type for
 * a future per-user rule. Note and draft share the artifacts read - a draft
 * conversion creates a note (createNoteInTx). A run has no domain-owned
 * title (the composition lives in the page layer), so its view carries no
 * title; the check exists to verify the run resolves.
 */
const noteLookup: EntityLookup = async (auth, id) => {
  const detail = await getNote(auth, id);
  return detail ? { title: detail.title } : null;
};
const ENTITY_LOOKUPS: Record<string, EntityLookup> = {
  capture: async (auth, id) => {
    const row = await getCapture(auth, id);
    return row ? { title: row.title ?? null } : null;
  },
  task: async (auth, id) => {
    const detail = await getTaskDetail(auth, id);
    return detail ? { title: detail.task.title } : null;
  },
  contact: async (auth, id) => {
    const detail = await getContactDetail(auth, { contactId: id });
    return detail ? { title: detail.contact.fullName } : null;
  },
  company: async (auth, id) => {
    const detail = await getCompanyDetail(auth, { companyId: id });
    return detail ? { title: detail.company.name } : null;
  },
  document: async (auth, id) => {
    const title = await getDocumentTitle(auth, id);
    return title === null ? null : { title };
  },
  run: async (auth, id) => {
    const run = await getRun(auth.workspaceId, id);
    return run ? { title: null } : null;
  },
  note: noteLookup,
  draft: noteLookup,
};

/**
 * A registry route becomes a Destination only after the entity check: a hit
 * keeps the href; a checked miss is gone, so the reason is "deleted"; a type
 * with no per-entity check (the integrations settings surface) keeps its
 * route, because the surface always exists. The view being undefined is what
 * distinguishes "never checked" from "checked and gone".
 */
function resolveVerified(route: Destination | null, view: EntityView | undefined): Destination | null {
  if (!route || "state" in route) return route;
  if (view === undefined) return route;
  return view ? route : { state: "unavailable", reason: "deleted" };
}

function subjectRouteOf(definition: EventDefinition, metadata: unknown, row: ActivityEventRow): Destination | null {
  const payload = typeof metadata === "object" && metadata !== null ? (metadata as { [x: string]: unknown }) : {};
  return definition.destinations(payload, {
    subjectType: row.subjectType,
    subjectId: row.subjectId,
  });
}

type ItemInput = {
  viewerId: string;
  userNames: Map<string, string | null>;
  agentLabels: Map<string, string>;
  /** Row id to raw metadata, loaded inside the audit domain only. */
  metadataMap: Map<string, unknown>;
  /** Entity key (`type:id`) to the checked view; absent means never checked. */
  views: Map<string, EntityView>;
  /** Rows folded into this item's disclosure, oldest first. */
  stepRows: ActivityEventRow[];
};

/**
 * Assemble one ActivityItem from a row and its pre-fetched context (pure -
 * the DB orchestration lives in presentActivityEvents). Destinations resolve
 * here, per row: the registry's route verified against the entity checks, a
 * miss rendered honestly, never a dead href.
 */
export function buildActivityItem(row: ActivityEventRow, input: ItemInput): ActivityItem {
  const definition = resolveEventDefinition(row.action);
  const actor = resolveActorRef(row, input.viewerId, input.userNames, input.agentLabels);
  const metadata = input.metadataMap.get(row.id) ?? null;
  const sentence = selectSentence(row, metadata, actor);
  const conversion = parseConversionPayload(metadata);

  const subjectView = row.subjectId ? input.views.get(`${row.subjectType}:${row.subjectId}`) : undefined;
  const subjectDestination = resolveVerified(subjectRouteOf(definition, metadata, row), subjectView);

  let resultDestination: Destination | null = null;
  let resultTitle: string | null = null;
  if (conversion) {
    const route = conversionResultDestination(conversion);
    if (route) {
      const resultView = input.views.get(`${conversion.resultType}:${conversion.resultId}`);
      resultDestination = resolveVerified(route, resultView);
      if (resultView) resultTitle = resultView.title;
    }
  }

  // The outcome outranks the subject: a conversion's story leads with what
  // the capture became, and the capture rides along as a related chip.
  const resultIsHit = resultDestination !== null && !("state" in resultDestination);
  let primary: Destination | null;
  const related: Destination[] = [];
  if (resultIsHit) {
    primary = resultDestination;
    if (subjectDestination) related.push(subjectDestination);
  } else if (subjectDestination) {
    primary = subjectDestination;
    if (resultDestination) related.push(resultDestination);
  } else {
    primary = resultDestination;
  }

  const liveTitle = resultIsHit ? resultTitle : (subjectView?.title ?? null);
  return {
    id: row.id,
    occurredAt: row.createdAt,
    category: definition.category,
    sentence,
    title: conversion?.displaySnapshot?.title ?? liveTitle,
    actor,
    primary,
    related,
    steps: input.stepRows.map((step) =>
      selectSentence(
        step,
        input.metadataMap.get(step.id) ?? null,
        resolveActorRef(step, input.viewerId, input.userNames, input.agentLabels),
      ),
    ),
    attention: definition.attention,
    technical: {
      action: row.action,
      subjectType: row.subjectType,
      subjectId: row.subjectId,
      operationId: row.operationId,
    },
  };
}

function userActorIds(rows: ActivityEventRow[], viewerId: string): string[] {
  const ids = new Set<string>();
  for (const row of rows) {
    if (row.actorKind === "user" && row.actorId && row.actorId !== viewerId) ids.add(row.actorId);
  }
  return [...ids];
}

function agentActorIds(rows: ActivityEventRow[]): string[] {
  const ids = new Set<string>();
  for (const row of rows) {
    if (row.actorKind === "agent" && row.actorId) ids.add(row.actorId);
  }
  return [...ids];
}

/**
 * The rows' raw metadata, read inside the audit domain so no other module
 * ever holds it. Scoped to the workspace again even though the ids came from
 * a workspace-scoped read: the invariant should not depend on the caller.
 */
async function loadMetadataMap(workspaceId: string, rowIds: string[]): Promise<Map<string, unknown>> {
  if (rowIds.length === 0) return new Map();
  const rows = await db
    .select({ id: auditEvents.id, metadata: auditEvents.metadata })
    .from(auditEvents)
    .where(and(eq(auditEvents.workspaceId, workspaceId), inArray(auditEvents.id, rowIds)));
  return new Map(rows.map((row) => [row.id, row.metadata]));
}

/**
 * Present a page of audit rows (from listActivityEvents) as ActivityItems:
 * one batched metadata read, one batched hydration per actor source, one
 * batched set of per-domain entity checks - never per-row awaits. Ordered
 * input in, ordered items out; collapsed operation steps ride their
 * outcome's disclosure.
 */
export async function presentActivityEvents(auth: AuthContext, rows: ActivityEventRow[]): Promise<ActivityItem[]> {
  if (rows.length === 0) return [];
  const plans = planOperationGroups(rows);
  const foldedStepIds = new Set<string>();
  for (const plan of plans.values()) for (const step of plan.steps) foldedStepIds.add(step.id);
  const visibleRows = rows.filter((row) => !foldedStepIds.has(row.id));

  const [metadataMap, userNames, agentLabels] = await Promise.all([
    loadMetadataMap(
      auth.workspaceId,
      rows.map((row) => row.id),
    ),
    getUserDisplayNames(userActorIds(rows, auth.userId)),
    getAgentPrincipalLabels(auth.workspaceId, agentActorIds(rows)),
  ]);

  // Queue every entity check the visible rows can need - a subject with a
  // registry route, plus each conversion's result - then resolve them all
  // concurrently.
  const pending = new Map<string, Promise<EntityView>>();
  const queue = (entityType: string, entityId: string | null | undefined) => {
    const lookup = entityId ? ENTITY_LOOKUPS[entityType] : undefined;
    if (!entityId || !lookup) return;
    const id: string = entityId;
    const key = `${entityType}:${id}`;
    if (!pending.has(key)) pending.set(key, lookup(auth, id));
  };
  for (const row of visibleRows) {
    const conversion = parseConversionPayload(metadataMap.get(row.id) ?? null);
    if (conversion) queue(conversion.resultType, conversion.resultId);
    if (
      row.subjectId &&
      subjectRouteOf(resolveEventDefinition(row.action), metadataMap.get(row.id) ?? null, row) !== null
    ) {
      queue(row.subjectType, row.subjectId);
    }
  }
  const settled = await Promise.all(
    [...pending.entries()].map(async ([key, promise]) => ({ key, view: await promise })),
  );
  const views = new Map(settled.map(({ key, view }) => [key, view]));

  return visibleRows.map((row) => {
    const plan = row.operationId ? plans.get(row.operationId) : undefined;
    return buildActivityItem(row, {
      viewerId: auth.userId,
      userNames,
      agentLabels,
      metadataMap,
      views,
      stepRows: plan && plan.outcome.id === row.id ? plan.steps : [],
    });
  });
}
