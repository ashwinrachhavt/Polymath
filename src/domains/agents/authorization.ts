import type { Capability } from "@/domains/identity/capabilities";
import type { TxDrizzle } from "@/lib/db-transaction";
import { NEVER_DELEGABLE } from "./delegation";
import type { EffectClass } from "./runtime-schema";
import { agentAuthorizationDecisions, type agentDelegationGrants } from "./schema";

/*
 * ASH-122 GA03: the deterministic tool-authorization gateway. One pure
 * function decides whether one tool invocation may proceed, from exactly
 * three inputs: the delegation grant, the operation registry, and the
 * invocation itself. There is no ambient authority to consult, so there is
 * nothing to forget.
 *
 * The rules (GA03 acceptance, each with confused-deputy coverage in
 * tests/unit/tool-authorization.test.ts):
 *  - DENY BY DEFAULT: an operation the registry does not know is denied;
 *    a capability the grant does not carry is denied; a bound the grant
 *    leaves null is denied (null means "not delegated", not "anything").
 *  - Agent tool visibility is NOT authorization: the profile's allowedTools
 *    ceiling is checked separately (profileCeiling) and can only narrow.
 *  - A tampered grant is a dead grant: the caller recomputes the content
 *    hash from the stored row (hashDelegationGrant) and passes it in; a
 *    mismatch with the row's pinned hash denies.
 *  - Reads and internal writes authorize directly; external effects and
 *    paid operations authorize only as REQUIRES_APPROVAL - the exact-action
 *    approval binding (GA06) is the runtime-side slice recorded in ADR 0006.
 *  - A denial is a verdict, not an exception: callers record it
 *    (agent_authorization_decisions) and cause no effect.
 */

export type ToolOperationSpec = {
  /** The catalog capability this operation requires, or null when catalog v1 has no honest mapping. */
  capability: Capability | null;
  effectClass: EffectClass;
  /** External effects and paid operations never execute on grant authority alone. */
  requiresApproval?: boolean;
  /** Free-text note for the registry's reviewers. */
  note?: string;
};

/*
 * The operation registry: every tool operation an agent may attempt, mapped
 * to its capability and effect class. A tool's presence in a profile's
 * allowedTools does not put it here - this list is the reviewable boundary,
 * and changing it is a code review, not a config edit.
 *
 * Catalog v2 (ADR 0006 Q2) added task.read and knowledge.read, so tasks.read
 * now maps honestly instead of being laundered through document.read. The
 * registry stays in code on purpose (ADR 0006 Q4, owner-approved): adding an
 * operation is a code review, never runtime data an owner edits.
 */
export const TOOL_OPERATION_REGISTRY: Record<string, ToolOperationSpec> = {
  "tasks.read": {
    capability: "task.read",
    effectClass: "read",
  },
  "documents.search": { capability: "document.read", effectClass: "read" },
  /*
   * ASH-306: conversational navigation lists records rather than reading a
   * document's text, so it is authorized at the honest knowledge granularity
   * the v2 catalog added. A task listing stays on task.read; notes are
   * knowledge, not tasks.
   */
  "records.browse": { capability: "knowledge.read", effectClass: "read" },
  /* ASH-283: a Notion write is an external effect, never a grant-only action. */
  "notion.page.append": {
    capability: "action.execute",
    effectClass: "external_effect",
    requiresApproval: true,
    note: "Approval binds the exact markdown and its content hash before anything is written.",
  },
  "notion.page.create": {
    capability: "action.execute",
    effectClass: "external_effect",
    requiresApproval: true,
    note: "Approval binds the exact markdown and its content hash before anything is written.",
  },
  /*
   * ASH-279, authority correction: debriefing a transcript persists review-
   * queue proposal rows (proposeTask/proposeNote in domains/knowledge/
   * meeting-debrief.ts), so "knowledge.read / read / creates nothing"
   * understated the effect. This is an internal write under action.prepare:
   * preparing a supervised action is its own catalog capability on purpose.
   *
   * BEHAVIOR CHANGE (rollout note for reviewers): delegation grants issued
   * before this fix authorized meetings.debrief through knowledge.read; they
   * now deny with operation_not_granted until re-granted action.prepare.
   * Run policy snapshots are unaffected - they allowlist operation names
   * (DEFAULT_ALLOWED_TOOLS), not catalog capabilities, so first-party runs
   * keep working; only the GA03 grant path tightens, and it tightens toward
   * deny-by-default. The external world is unchanged: the tool still never
   * creates tasks, and approval of its proposals still sits with the owner.
   */
  "meetings.debrief": {
    capability: "action.prepare",
    effectClass: "internal_write",
    note: "Persists task/note/follow-up proposals in the review queue; creates no tasks.",
  },
  "web.search": { capability: "integration.use", effectClass: "read", note: "Egress: query terms leave the workspace." },
  "web.fetch": { capability: "integration.use", effectClass: "read", note: "Egress: the fetched URL leaves the workspace." },
  /*
   * The provider gateway's Gmail reads, keyed by the capability names the
   * gateway dispatches on. They were absent while the gateway did not dispatch,
   * which would have made every granted read deny as `unknown_operation`.
   * Reading a mailbox is integration use, the same authority the connected
   * reads already carried.
   */
  "gmail.read": { capability: "integration.use", effectClass: "read" },
  "gmail.thread.read": { capability: "integration.use", effectClass: "read" },
  "github.read": { capability: "integration.use", effectClass: "read" },
  "github.issue.read": { capability: "integration.use", effectClass: "read" },
  "slack.channels.read": { capability: "integration.use", effectClass: "read" },
  "slack.read": { capability: "integration.use", effectClass: "read" },
  "linear.read": { capability: "integration.use", effectClass: "read" },
  "linear.issue.read": { capability: "integration.use", effectClass: "read" },
  /*
   * ASH-285: drafting persists a proposal note, so this is an internal write
   * under action.prepare - not a read. The "creates nothing" phrasing on
   * meetings.debrief describes its external world only; both tools write
   * rows, and this entry says so. The external Linear write stays a separate
   * approved action, so nothing here requires approval.
   */
  "linear.issue.propose": {
    capability: "action.prepare",
    effectClass: "internal_write",
    note: "Persists a Linear-issue proposal note in the workspace; never calls Linear.",
  },
  /*
   * ASH-282: proposing a calendar move persists a review card, so this is an
   * internal write under action.prepare. Approval moves the local event only;
   * Google-sourced events are advice-only and never written back.
   */
  "calendar.propose": {
    capability: "action.prepare",
    effectClass: "internal_write",
    note: "Persists a calendar-change proposal in the review queue; approval moves local events only, never the provider.",
  },
  /*
   * The generic registry's reads, same authority as the gateway reads above:
   * integration use, read-only, no approval. Keyed by the capability names the
   * gateway dispatches on.
   */
  "googlecalendar.events.read": { capability: "integration.use", effectClass: "read" },
  "googledrive.files.read": { capability: "integration.use", effectClass: "read" },
  "googledocs.documents.read": { capability: "integration.use", effectClass: "read" },
  "googlesheets.spreadsheets.read": { capability: "integration.use", effectClass: "read" },
  "discord.guilds.read": { capability: "integration.use", effectClass: "read" },
  "zoom.meetings.read": { capability: "integration.use", effectClass: "read" },
  "calendly.events.read": { capability: "integration.use", effectClass: "read" },
  "asana.tasks.read": { capability: "integration.use", effectClass: "read" },
  "trello.cards.read": { capability: "integration.use", effectClass: "read" },
  "airtable.bases.read": { capability: "integration.use", effectClass: "read" },
  "canva.designs.read": { capability: "integration.use", effectClass: "read" },
  "hubspot.contacts.read": { capability: "integration.use", effectClass: "read" },
  "stripe.payments.read": { capability: "integration.use", effectClass: "read" },
  "gmail.send": {
    capability: "action.execute",
    effectClass: "external_effect",
    requiresApproval: true,
    note: "An exact-action approval (GA06) binds recipient and payload before this executes.",
  },
};

export type GrantForAuthorization = Pick<
  typeof agentDelegationGrants.$inferSelect,
  | "revokedAt"
  | "expiresAt"
  | "contentHash"
  | "allowedOperations"
  | "allowedResources"
  | "allowedAccounts"
  | "allowedDestinations"
  | "delegationDepth"
>;

export type ToolInvocationRequest = {
  operation: string;
  accountAlias?: string;
  /** "kind:uuid" resource reference, when the invocation targets one record. */
  resourceRef?: string;
  /** Egress destination (host, address) when the invocation sends data out. */
  destination?: string;
  /** The profile's allowedTools ceiling, if the run snapshot carries one. */
  profileCeiling?: readonly string[];
  now: Date;
  /** Recomputed from the stored grant row via hashDelegationGrant. */
  expectedContentHash: string;
};

export type AuthorizationDecision =
  | { allowed: true; requiresApproval: boolean }
  | { allowed: false; reasons: string[] };

export function authorizeToolInvocation(
  grant: GrantForAuthorization,
  request: ToolInvocationRequest,
): AuthorizationDecision {
  const reasons: string[] = [];

  const spec = TOOL_OPERATION_REGISTRY[request.operation];
  if (!spec) reasons.push("unknown_operation");
  if (spec && spec.capability === null) reasons.push("no_capability_mapping");
  if (spec?.capability && NEVER_DELEGABLE.includes(spec.capability)) reasons.push("never_delegable");

  if (grant.revokedAt) reasons.push("grant_revoked");
  if (grant.expiresAt.getTime() <= request.now.getTime()) reasons.push("grant_expired");
  if (grant.contentHash !== request.expectedContentHash) reasons.push("grant_tampered");

  if (spec?.capability) {
    const operations = new Set(grant.allowedOperations as string[]);
    if (!operations.has(spec.capability)) reasons.push("operation_not_granted");
  }
  if (request.accountAlias) {
    const accounts = (grant.allowedAccounts as string[] | null) ?? [];
    if (!accounts.includes(request.accountAlias)) reasons.push("account_not_granted");
  }
  if (request.resourceRef) {
    const resources = (grant.allowedResources as string[] | null) ?? [];
    if (!resources.includes(request.resourceRef)) reasons.push("resource_not_granted");
  }
  if (request.destination) {
    const destinations = (grant.allowedDestinations as string[] | null) ?? [];
    if (!destinations.includes(request.destination)) reasons.push("destination_not_granted");
  }
  // The profile ceiling can only narrow what the grant allows; visibility is not authorization.
  if (request.profileCeiling && !request.profileCeiling.includes(request.operation)) {
    reasons.push("outside_profile_ceiling");
  }

  if (reasons.length) return { allowed: false, reasons };
  return { allowed: true, requiresApproval: spec?.requiresApproval ?? false };
}

/*
 * The recording half: run the decision, persist the verdict in the caller's
 * transaction, and hand it back. A denied invocation writes a row and causes
 * no other effect - the log is the only thing a denial ever touches.
 */
export async function decideAndRecordToolInvocation(
  tx: TxDrizzle,
  input: {
    workspaceId: string;
    grantId: string;
    agentPrincipalId: string;
    runId?: string;
    invocationId?: string;
    grant: GrantForAuthorization;
    request: ToolInvocationRequest;
  },
): Promise<AuthorizationDecision> {
  const decision = authorizeToolInvocation(input.grant, input.request);
  await tx.insert(agentAuthorizationDecisions).values({
    workspaceId: input.workspaceId,
    grantId: input.grantId,
    agentPrincipalId: input.agentPrincipalId,
    runId: input.runId ?? null,
    invocationId: input.invocationId ?? null,
    operation: input.request.operation,
    accountAlias: input.request.accountAlias ?? null,
    resourceRef: input.request.resourceRef ?? null,
    destination: input.request.destination ?? null,
    decision: decision.allowed ? "allowed" : "denied",
    reasons: decision.allowed ? [] : decision.reasons,
    requiresApproval: decision.allowed ? decision.requiresApproval : false,
    grantContentHash: input.grant.contentHash,
  });
  return decision;
}
