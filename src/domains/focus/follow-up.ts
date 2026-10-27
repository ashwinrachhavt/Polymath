import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { ClaimedOutboxEvent, OutboxHandler } from "@/domains/audit/outbox";
import { recordAudit } from "@/domains/audit/record";
import type { AuthContext } from "@/domains/identity/resolve";
import { createEngine, type SessionDriver } from "@/domains/agents/engine";
import { createEveDriver, eveBridgeUnavailableReason } from "@/domains/agents/eve-driver";
import { agentRuns } from "@/domains/agents/schema";
import { correspondence, contacts } from "@/domains/crm/schema";
import { taskLinks, tasks } from "@/domains/work/schema";
import { db } from "@/lib/db";
import { focusSessions } from "./schema";

/*
 * The Commit/Focus hand-off (ASH-288). A finished focus session that touched
 * an external contact earns ONE delegated Writer run, which drafts the
 * follow-up pair (email + calendar reminder) as two independently
 * approvable proposals.
 *
 * The trigger is deterministic, no model: finishFocusSession enqueues this
 * topic in the finish transaction (deduped on the session id, so a replayed
 * finish cannot double-start). This handler resolves the external party from
 * the task's links - a linked contact, or the contact behind a linked
 * thread's latest correspondence. No resolvable party: silent, no run, no
 * spend. An ambiguous resolution (several distinct contacts) never guesses a
 * recipient: no run, and the audit row says why.
 *
 * The run's job and its proposals live in writer-draft.ts (draftFollowUp);
 * the run parks itself after filing, the way every finished turn does.
 */

export const FOCUS_FOLLOW_UP_TOPIC = "focus.follow_up_requested";

export type PartyResolution =
  | { kind: "resolved"; contactId: string; contactName: string; contactEmail: string | null; threadId: string | null }
  | { kind: "ambiguous"; contactIds: string[] }
  | { kind: "none" };

/** The external party behind a task's links, resolved by code alone. */
export async function resolveFollowUpParty(workspaceId: string, taskId: string): Promise<PartyResolution> {
  const links = await db
    .select({ targetType: taskLinks.targetType, targetId: taskLinks.targetId })
    .from(taskLinks)
    .where(
      and(
        eq(taskLinks.workspaceId, workspaceId),
        eq(taskLinks.taskId, taskId),
        inArray(taskLinks.targetType, ["contact", "thread"]),
      ),
    );
  if (links.length === 0) return { kind: "none" };

  const contactIds = new Set<string>();
  let threadId: string | null = null;

  for (const link of links) {
    if (link.targetType === "contact") {
      contactIds.add(link.targetId);
      continue;
    }
    // A linked thread resolves through its latest correspondence: the thread
    // id task_links stores is the provider thread id, and the correspondence
    // row is where it meets a contact.
    const [row] = await db
      .select({ contactId: correspondence.contactId, threadId: correspondence.threadId })
      .from(correspondence)
      .where(
        and(
          eq(correspondence.workspaceId, workspaceId),
          // The link's target id is a uuid; provider thread ids are text. A
          // correspondence row's own id linked directly also lands here.
          sql`(${correspondence.threadId} = ${link.targetId} or ${correspondence.id}::text = ${link.targetId})`,
        ),
      )
      .orderBy(desc(correspondence.occurredAt))
      .limit(1);
    if (row?.contactId) {
      contactIds.add(row.contactId);
      threadId = row.threadId ?? threadId;
    }
  }

  if (contactIds.size === 0) return { kind: "none" };
  if (contactIds.size > 1) return { kind: "ambiguous", contactIds: [...contactIds] };

  const contactId = [...contactIds][0];
  const [contact] = await db
    .select({ id: contacts.id, fullName: contacts.fullName, primaryEmail: contacts.primaryEmail })
    .from(contacts)
    .where(and(eq(contacts.id, contactId), eq(contacts.workspaceId, workspaceId)))
    .limit(1);
  if (!contact) return { kind: "none" };
  return { kind: "resolved", contactId: contact.id, contactName: contact.fullName, contactEmail: contact.primaryEmail, threadId };
}

/** The objective is the whole brief for the Writer run; ids, never prose it must parse. */
export function followUpObjective(input: {
  taskTitle: string;
  contactName: string;
  session: { outcome: string | null; whatChanged: string | null; nextStep: string | null };
}): string {
  const lines = [
    `Draft the follow-up pair for the finished focus session on "${input.taskTitle}" with ${input.contactName}.`,
    "Call writer_draft_follow_up once with the session and contact context below.",
    "The session's own record:",
  ];
  if (input.session.outcome) lines.push(`Outcome: ${input.session.outcome}`);
  if (input.session.whatChanged) lines.push(`What changed: ${input.session.whatChanged}`);
  if (input.session.nextStep) lines.push(`Next step: ${input.session.nextStep}`);
  return lines.join("\n");
}

export function followUpRequestedHandler(
  ownerAuth: (workspaceId: string) => Promise<AuthContext | null>,
  driver?: SessionDriver,
): OutboxHandler {
  return async (event: ClaimedOutboxEvent) => {
    const raw = event.payload ?? {};
    const sessionId = typeof (raw as { sessionId?: unknown }).sessionId === "string" ? (raw as { sessionId: string }).sessionId : null;
    if (!sessionId) throw new Error(`${FOCUS_FOLLOW_UP_TOPIC} is missing sessionId`);

    const [session] = await db
      .select()
      .from(focusSessions)
      .where(and(eq(focusSessions.id, sessionId), eq(focusSessions.workspaceId, event.workspaceId)))
      .limit(1);
    // Only a finished session with a linked task can earn the hand-off; a
    // replayed or abandoned finish stops here.
    if (!session || session.state !== "finished" || !session.taskId) return;

    const auth = await ownerAuth(event.workspaceId);
    if (!auth) throw new Error("workspace has no active owner to act for the follow-up hand-off");

    const resolution = await resolveFollowUpParty(event.workspaceId, session.taskId);
    if (resolution.kind !== "resolved") {
      // Silent by design (no unconditional runs): the audit row is the only
      // trace, and for an ambiguous resolution it says no recipient was guessed.
      await recordAudit(auth, {
        action: "focus.follow_up_skipped",
        subjectType: "focus_session",
        subjectId: session.id,
        summary:
          resolution.kind === "ambiguous"
            ? `Follow-up skipped: the task links resolve to ${resolution.contactIds.length} contacts; no recipient was guessed`
            : "Follow-up skipped: no external party is linked to the session's task",
      });
      return;
    }

    const [task] = await db
      .select({ title: tasks.title })
      .from(tasks)
      .where(and(eq(tasks.id, session.taskId), eq(tasks.workspaceId, event.workspaceId)))
      .limit(1);
    const taskTitle = task?.title ?? "the task";

    // A redelivered event (a lost lease, not a second finish) must not start
    // a second run: the linkage rides the run's subjects, so the replay check
    // is a read, not a column.
    const subject = JSON.stringify([{ type: "focus_session", id: session.id }]);
    const existing = await db
      .select({ id: agentRuns.id })
      .from(agentRuns)
      .where(
        and(
          eq(agentRuns.workspaceId, event.workspaceId),
          sql`${agentRuns.subjects} @> ${subject}::jsonb`,
          sql`${agentRuns.state} in ('queued', 'running', 'waiting_input', 'waiting_approval')`,
        ),
      )
      .limit(1);
    if (existing.length > 0) return;

    // The bridge check mirrors every other run-starting surface: no runtime,
    // no run, and the reason is the same one the owner sees elsewhere.
    const unavailable = eveBridgeUnavailableReason();
    if (unavailable) {
      await recordAudit(auth, {
        action: "focus.follow_up_skipped",
        subjectType: "focus_session",
        subjectId: session.id,
        summary: `Follow-up skipped: ${unavailable}`,
      });
      return;
    }

    const { runId } = await createEngine(driver ?? createEveDriver()).start({
      auth,
      profileName: "alfred",
      objective: followUpObjective({
        taskTitle,
        contactName: resolution.contactName,
        session: { outcome: session.outcome, whatChanged: session.whatChanged, nextStep: session.nextStep },
      }),
      subjects: [
        { type: "focus_session", id: session.id },
        { type: "task", id: session.taskId },
        { type: "contact", id: resolution.contactId },
        ...(resolution.threadId ? [{ type: "thread", id: resolution.threadId }] : []),
      ],
      // A draft pair is one Writer pass plus reads; the reservation only ever
      // bounds it, the settle refunds what was not spent.
      estimateUsd: "0.25",
    });

    await recordAudit(auth, {
      action: "focus.follow_up_started",
      subjectType: "focus_session",
      subjectId: session.id,
      summary: `Started the follow-up Writer run for ${resolution.contactName}`,
      metadata: { runId, contactId: resolution.contactId, threadId: resolution.threadId },
    });
  };
}
