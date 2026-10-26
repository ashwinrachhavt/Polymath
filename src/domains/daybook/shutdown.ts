import { and, desc, eq, inArray, isNull, notInArray, sql } from "drizzle-orm";
import { createProposal, senderAccountPin, withSenderAccountPin } from "@/domains/actions/commands";
import { actionRevisions } from "@/domains/actions/schema";
import { recordAudit } from "@/domains/audit/record";
import { withReceipt } from "@/domains/audit/receipt";
import { captureLinkLabel } from "@/domains/capture/queries";
import { parkCaptureInTx } from "@/domains/capture/parking";
import { captures } from "@/domains/capture/schema";
import { abandonFocusSession, finishFocusSession } from "@/domains/focus/commands";
import { getActiveFocusSession, type FocusSessionView } from "@/domains/focus/queries";
import { focusSessions } from "@/domains/focus/schema";
import type { AuthContext } from "@/domains/identity/resolve";
import { createNoteInTx } from "@/domains/knowledge/notes";
import { artifacts } from "@/domains/knowledge/schema";
import { resolveConnectedAccount } from "@/domains/integrations/queries";
import { tierAllows } from "@/domains/integrations/capabilities";
import { getBriefing } from "@/domains/work/briefing";
import { briefingSeeds, tasks } from "@/domains/work/schema";
import { db } from "@/lib/db";
import { withTransaction, type TxDrizzle } from "@/lib/db-transaction";
import { dayArtifactPins } from "./schema";

/*
 * The end-of-day shutdown ritual (ASH-305). One command, one confirmation:
 * the owner reads a preview, makes explicit choices, and a single apply does
 * every local effect in ONE transaction, idempotent on a client key, so a
 * double-click or a retry after a crash cannot close, park, seed or log twice.
 *
 *   sessions  a live focus session is finished, abandoned, or explicitly left
 *             running. There is no default: apply refuses until the owner has
 *             chosen. Planned (scheduled, not started) sessions are never touched.
 *   captures  the owner-ticked open captures are PARKED (recoverable; see
 *             capture/parking.ts). Nothing is discarded or converted.
 *   briefing  chosen open tasks become briefing_seeds for the next local day:
 *             a suggestion that leads tomorrow's list, never an accepted outcome.
 *   log       a "Shutdown log" note, pinned to the day, records what was done.
 *   email     optional. Only with an explicit recipient and connected account;
 *             the result is a gmail.send PROPOSAL in the review queue. This
 *             module never sends mail, never guesses a recipient.
 */

export class ShutdownIncompleteError extends Error {
  readonly code = "shutdown_incomplete";
}
export class ShutdownStaleError extends Error {
  readonly code = "stale_write";
}

const OPEN_CAPTURE_STATES = ["unprocessed", "classifying", "enriched", "failed"] as const;
const MAX_LIST = 50;

export type ShutdownPreview = {
  today: string;
  tomorrow: string;
  liveSession: Pick<FocusSessionView, "id" | "version" | "subject" | "state" | "elapsedSeconds" | "taskId" | "outcome"> | null;
  /** Planned sessions are shown for context only; shutdown never changes them. */
  plannedSessionCount: number;
  captures: Array<{ id: string; version: number; label: string; kind: string; state: string }>;
  seedCandidates: Array<{ taskId: string; title: string; reason: string }>;
  /** The day's already-written shutdown log: a remount renders the saved confirmation, never a fresh form that would duplicate it. */
  closedLog: { id: string; title: string } | null;
};

export type SessionChoice =
  | { sessionId: string; expectedVersion: number; action: "leave" }
  | { sessionId: string; expectedVersion: number; action: "abandon"; reason?: string | null }
  | {
      sessionId: string;
      expectedVersion: number;
      action: "finish";
      outcome?: string | null;
      whatChanged?: string | null;
      nextStep?: string | null;
    };

export type ShutdownInput = {
  /** One key per ritual attempt: a replay returns the first result and changes nothing. */
  idempotencyKey: string;
  session?: SessionChoice;
  park: Array<{ captureId: string; expectedVersion: number }>;
  seedTaskIds: string[];
  /** Explicit per run. No default recipient exists. */
  email?: { to: string; accountAlias: string | null } | null;
};

export type ShutdownResult = {
  today: string;
  tomorrow: string;
  session: { id: string; action: SessionChoice["action"] } | null;
  parked: number;
  seeded: number;
  logNoteId: string;
  /** true when this apply changed nothing because the day was already closed; the returned log is the earlier one. */
  replayed: boolean;
  email:
    | { status: "not_requested" }
    | { status: "proposed"; proposalId: string; deduplicated: boolean }
    | { status: "skipped"; reason: string };
};

/** The workspace-local day and the next one, with the same timezone rule the briefing uses. */
async function localDays(tx: TxDrizzle | typeof db, auth: AuthContext): Promise<{ today: string; tomorrow: string }> {
  const rows = await tx.execute(sql`
    with d as (
      select (now() at time zone coalesce(
        (select timezone from user_preferences where workspace_id = ${auth.workspaceId} and user_id = ${auth.userId}), 'UTC'
      ))::date as today
    )
    select today::text as today, (today + 1)::text as tomorrow from d
  `);
  return (rows as unknown as Array<{ today: string; tomorrow: string }>)[0];
}

const shutdownLogTitle = (today: string) => `Shutdown log ${today}`;

/** The day's already-written shutdown log, if an earlier apply pinned one. */
async function findShutdownLog(tx: TxDrizzle | typeof db, auth: AuthContext, today: string): Promise<{ id: string; title: string } | null> {
  const rows = await tx
    .select({ id: artifacts.id, title: artifacts.title })
    .from(dayArtifactPins)
    .innerJoin(artifacts, eq(artifacts.id, dayArtifactPins.artifactId))
    .where(
      and(
        eq(dayArtifactPins.workspaceId, auth.workspaceId),
        eq(dayArtifactPins.userId, auth.userId),
        eq(dayArtifactPins.localDate, today),
        eq(artifacts.title, shutdownLogTitle(today)),
      ),
    )
    .orderBy(desc(artifacts.createdAt))
    .limit(1);
  return rows[0] ?? null;
}

export async function previewShutdown(auth: AuthContext): Promise<ShutdownPreview> {
  const [days, live, planned, openCaptures, briefing] = await Promise.all([
    localDays(db, auth),
    getActiveFocusSession(auth),
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(focusSessions)
      .where(
        and(
          eq(focusSessions.workspaceId, auth.workspaceId),
          eq(focusSessions.state, "paused"),
          isNull(focusSessions.startedAt),
          sql`${focusSessions.scheduledAt} is not null`,
        ),
      ),
    db
      .select({
        id: captures.id,
        version: captures.version,
        kind: captures.kind,
        state: captures.processingState,
        text: captures.text,
        url: captures.url,
      })
      .from(captures)
      .where(
        and(
          eq(captures.workspaceId, auth.workspaceId),
          inArray(captures.processingState, [...OPEN_CAPTURE_STATES]),
          isNull(captures.parkedAt),
          isNull(captures.archivedAt),
        ),
      )
      .orderBy(desc(captures.createdAt))
      .limit(MAX_LIST),
    getBriefing(auth),
  ]);

  const seen = new Set<string>();
  const seedCandidates: ShutdownPreview["seedCandidates"] = [];
  const add = (list: Array<{ id: string; title: string }>, reason: string) => {
    for (const task of list) {
      if (seen.has(task.id) || seedCandidates.length >= 10) continue;
      seen.add(task.id);
      seedCandidates.push({ taskId: task.id, title: task.title, reason });
    }
  };
  // Deterministic reasons only: what the record already says, not a model's opinion.
  add(briefing.outcomes, "Accepted for today and not finished");
  add(briefing.dueTodayOrOverdue, "Due today or overdue");

  const closedLog = await findShutdownLog(db, auth, days.today);
  return {
    today: days.today,
    tomorrow: days.tomorrow,
    closedLog,
    liveSession: live
      ? {
          id: live.id,
          version: live.version,
          subject: live.subject,
          state: live.state,
          elapsedSeconds: live.elapsedSeconds,
          taskId: live.taskId,
          outcome: live.outcome,
        }
      : null,
    plannedSessionCount: planned[0]?.n ?? 0,
    captures: openCaptures.map((c) => ({
      id: c.id,
      version: c.version,
      kind: c.kind,
      state: c.state,
      label: captureLinkLabel(c),
    })),
    seedCandidates,
  };
}

const EMAIL = /^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/;

type LogLine = string;

function logDoc(title: string, lines: LogLine[]) {
  const text = (value: string) => ({ type: "text", text: value });
  return {
    type: "doc",
    content: [
      { type: "heading", attrs: { level: 2 }, content: [text(title)] },
      {
        type: "bulletList",
        content: lines.map((line) => ({ type: "listItem", content: [{ type: "paragraph", content: [text(line)] }] })),
      },
    ],
  };
}

export async function applyShutdown(auth: AuthContext, input: ShutdownInput): Promise<ShutdownResult> {
  if (!input.idempotencyKey) throw new ShutdownIncompleteError("A shutdown needs an idempotency key.");
  const email = input.email ?? null;
  if (email && !EMAIL.test(email.to.trim())) {
    throw new ShutdownIncompleteError("That recipient is not an email address.");
  }
  // The sender identity is resolved BEFORE the transaction (it reads the
  // grant and the connected account); an unresolved one skips the email and
  // says why in the log, it never falls back to another account.
  const pin = email ? await senderAccountPin(auth, "gmail.send", email.accountAlias) : null;
  // The same live gates the agent gateway applies to a send proposal: the
  // connection's tier and its Send switch. A proposal the owner could not have
  // gotten through Connectors is not filed.
  let sendBlock: string | null = null;
  if (pin?.resolved) {
    const account = await resolveConnectedAccount(auth, "gmail", pin.alias);
    if (!account.ok) sendBlock = account.message;
    else if (!tierAllows("gmail", account.accessTier, "gmail.send") || account.disabledCapabilities.includes("gmail.send")) {
      sendBlock = `Send access is off for ${pin.alias}. Turn it on in Connectors first.`;
    }
  }

  return withTransaction(async (tx) => {
    const { value } = await withReceipt(
      tx,
      auth,
      `shutdown:${input.idempotencyKey}`,
      { op: "applyShutdown", session: input.session ?? null, park: input.park, seedTaskIds: input.seedTaskIds, email },
      async (): Promise<ShutdownResult> => {
        const days = await localDays(tx, auth);
        const alreadyClosed = await findShutdownLog(tx, auth, days.today);
        const lines: LogLine[] = [];

        // 1. The live session needs an explicit choice; "leave" is a choice.
        const [live] = await tx
          .select({ id: focusSessions.id, subject: focusSessions.subject })
          .from(focusSessions)
          .where(
            and(
              eq(focusSessions.workspaceId, auth.workspaceId),
              inArray(focusSessions.state, ["running", "paused"]),
              sql`${focusSessions.startedAt} is not null`,
            ),
          )
          .limit(1);
        let session: ShutdownResult["session"] = null;
        if (live && !input.session) {
          throw new ShutdownIncompleteError("A focus session is still open. Choose finish, abandon, or leave it running.");
        }
        if (input.session) {
          const choice = input.session;
          if (!live || live.id !== choice.sessionId) {
            throw new ShutdownStaleError("The open focus session changed since you loaded it. Reload and try again.");
          }
          const label = live.subject ?? "focus session";
          if (choice.action === "finish") {
            await finishFocusSession(
              auth,
              {
                sessionId: choice.sessionId,
                expectedVersion: choice.expectedVersion,
                outcome: choice.outcome,
                whatChanged: choice.whatChanged,
                nextStep: choice.nextStep,
              },
              tx,
            );
            lines.push(`Finished ${label}${choice.outcome?.trim() ? `: ${choice.outcome.trim()}` : ""}`);
          } else if (choice.action === "abandon") {
            await abandonFocusSession(
              auth,
              { sessionId: choice.sessionId, expectedVersion: choice.expectedVersion, reason: choice.reason?.trim() || "Closed at end-of-day shutdown" },
              tx,
            );
            lines.push(`Abandoned ${label}`);
          } else {
            lines.push(`Left ${label} running`);
          }
          session = { id: choice.sessionId, action: choice.action };
        }

        // 2. Park the ticked captures (each version-guarded; any stale one aborts the whole apply).
        for (const item of input.park) await parkCaptureInTx(tx, auth, item);
        if (input.park.length > 0) lines.push(`Parked ${input.park.length} capture${input.park.length === 1 ? "" : "s"}`);

        // 3. Seed tomorrow. Only this workspace's open tasks qualify; a dismissed
        //    (archived) seed keeps its unique key, so a replay cannot resurrect it.
        const seedIds = [...new Set(input.seedTaskIds)];
        let seeded = 0;
        if (seedIds.length > 0) {
          const valid = await tx
            .select({ id: tasks.id, title: tasks.title })
            .from(tasks)
            .where(
              and(
                eq(tasks.workspaceId, auth.workspaceId),
                inArray(tasks.id, seedIds),
                isNull(tasks.archivedAt),
                notInArray(tasks.status, ["done", "cancelled"]),
              ),
            );
          if (valid.length !== seedIds.length) {
            throw new ShutdownStaleError("A task you chose is no longer open. Reload and try again.");
          }
          const inserted = await tx
            .insert(briefingSeeds)
            .values(
              valid.map((task) => ({
                workspaceId: auth.workspaceId,
                onDate: days.tomorrow,
                taskId: task.id,
                reason: "Carried over by the end-of-day shutdown",
                createdBy: auth.userId,
                updatedBy: auth.userId,
              })),
            )
            .onConflictDoNothing({ target: [briefingSeeds.workspaceId, briefingSeeds.onDate, briefingSeeds.taskId] })
            .returning({ id: briefingSeeds.id });
          seeded = inserted.length;
          for (const task of valid) lines.push(`Seeded for ${days.tomorrow}: ${task.title}`);
        }

        // 4. Email: a review-queue PROPOSAL only, from an explicit recipient and account.
        let emailResult: ShutdownResult["email"] = { status: "not_requested" };
        if (email) {
          if (!pin || !pin.resolved || sendBlock) {
            const reason = sendBlock ?? (pin && !pin.resolved && pin.reason ? pin.reason : "No connected Gmail account matched.");
            emailResult = { status: "skipped", reason };
            lines.push(`Email not proposed: ${reason}`);
          } else {
            const subject = `Shutdown ${days.today}`;
            const body = [`Shutdown summary for ${days.today}`, "", ...lines.map((l) => `- ${l}`)].join("\n");
            const to = email.to.trim();
            const payload = { to, subject, body, inReplyTo: null, accountAlias: pin.alias };
            const created = await createProposal(
              tx,
              { workspaceId: auth.workspaceId },
              {
                capability: "gmail.send",
                riskClass: "external_write",
                targetType: "shutdown_summary",
                accountAlias: pin.alias,
                title: `Send shutdown summary to ${to}`,
                expectedEffect: `Sends the ${days.today} shutdown summary from ${pin.alias} to ${to}. Nothing is sent until you approve.`,
                // Per apply attempt, not per day: a second shutdown the same day with a revised
                // recipient is a new explicit ask and must not resolve to the first proposal
                // (which would carry the old address while the log names the new one). A
                // replay of the same attempt is caught earlier by the receipt.
                dedupeKey: `shutdown-email:${auth.workspaceId}:${input.idempotencyKey}`,
                expiresAt: new Date(Date.now() + 24 * 3600 * 1000),
              },
            );
            if (!created.deduplicated) {
              const pinned = withSenderAccountPin(pin, payload, { to, subject, body });
              await tx.insert(actionRevisions).values({
                workspaceId: auth.workspaceId,
                proposalId: created.proposalId,
                revisionNumber: 1,
                payload: pinned.payload,
                preview: pinned.preview,
                createdBy: auth.userId,
              });
            }
            emailResult = { status: "proposed", proposalId: created.proposalId, deduplicated: created.deduplicated };
            lines.push(`Summary email proposed to ${to} (waiting for your approval, not sent)`);
          }
        }

        // 5. The log: a note in the library, pinned to the day, same transaction.
        //    A repeat apply with nothing new to record (a remount or a retry of
        //    an already-closed day) replays the day's existing log instead of
        //    piling up a second "Nothing needed closing." note. A repeat that
        //    DOES change something is a deliberate second close and writes its
        //    own log, as before.
        if (alreadyClosed && lines.length === 0) {
          return {
            today: days.today,
            tomorrow: days.tomorrow,
            session: null,
            parked: 0,
            seeded: 0,
            logNoteId: alreadyClosed.id,
            replayed: true,
            email: emailResult,
          };
        }
        const logLines = lines.length > 0 ? lines : ["Nothing needed closing."];
        const note = await createNoteInTx(tx, auth, {
          title: shutdownLogTitle(days.today),
          content: logDoc(`Shutdown ${days.today}`, logLines),
          plainText: [`Shutdown ${days.today}`, ...logLines].join("\n"),
          kind: "note",
        });
        await tx
          .insert(dayArtifactPins)
          .values({ workspaceId: auth.workspaceId, userId: auth.userId, localDate: days.today, artifactId: note.id, createdBy: auth.userId })
          .onConflictDoNothing();
        await recordAudit(
          auth,
          {
            action: "daybook.shutdown",
            subjectType: "artifact",
            subjectId: note.id,
            summary: `Shutdown ${days.today}: ${logLines.length} item${logLines.length === 1 ? "" : "s"}`,
          },
          tx,
        );

        return {
          today: days.today,
          tomorrow: days.tomorrow,
          session,
          parked: input.park.length,
          seeded,
          logNoteId: note.id,
          replayed: false,
          email: emailResult,
        };
      },
    );
    return value;
  });
}
