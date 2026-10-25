import { and, eq, ilike, inArray, isNotNull, ne, or, sql } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "@/domains/audit/record";
import { eventAttendees, eventLinks, events } from "@/domains/calendar/schema";
import { contacts } from "@/domains/crm/schema";
import type { AuthContext } from "@/domains/identity/resolve";
import { tasks } from "@/domains/work/schema";
import { db } from "@/lib/db";
import { withTransaction } from "@/lib/db-transaction";
import { untrustedDataClauseJsonSafe } from "@/lib/prompts";
import {
  GenerationUnconfiguredError,
  generationProvider,
  type GenerationProvider,
} from "@/integrations/generation/provider";
import { artifacts, artifactVersions } from "./schema";
import { createNoteInTx } from "./notes";

/*
 * Meeting prep (ASH-302): given a calendar event, gather what the workspace
 * already knows - the people, the notes that mention them, the open loops -
 * and draft one prep report with proposed talking points. The report is a
 * knowledge artifact linked back to the event; regenerating before the
 * meeting writes a fresh report, because the context it reads may have moved.
 *
 * Everything the model sees comes from the owner's own workspace, and the
 * report never leaves it: there is nothing to approve, so this is a direct
 * owner-invoked read-then-write, not a proposal.
 */

export class MeetingPrepNotAllowedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MeetingPrepNotAllowedError";
  }
}

export class MeetingPrepUnusableAnswerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MeetingPrepUnusableAnswerError";
  }
}

export const PREP_MAX_NOTES = 5;
export const PREP_MAX_TASKS = 10;
export const PREP_MAX_TALKING_POINTS = 8;
export const PREP_MAX_CONTEXT_CHARS = 30_000;

const response = z.object({
  summary: z.string().trim().min(1).max(2000),
  attendeeBriefs: z.array(z.object({ name: z.string().trim().min(1).max(120), brief: z.string().trim().min(1).max(1000) })).max(10).nullable(),
  history: z.string().trim().min(1).max(3000).nullable(),
  openLoops: z.string().trim().min(1).max(3000).nullable(),
  talkingPoints: z.array(z.string().trim().min(1).max(300)).min(1).max(PREP_MAX_TALKING_POINTS),
});

export type MeetingPrepDraft = z.infer<typeof response>;

const SYSTEM = `You write a meeting prep report for the owner from their own workspace context. Return JSON with exactly these keys: {"summary": string, "attendeeBriefs": [{"name": string, "brief": string}]|null, "history": string|null, "openLoops": string|null, "talkingPoints": string[]}.
"summary": what this meeting is and why it matters now, two or three sentences.
"attendeeBriefs": one entry per person attending who appears in the context; what the owner knows about them, plainly.
"history": what past notes say that matters for this meeting; null when no notes are relevant.
"openLoops": open tasks touching these people or this topic; null when there are none.
"talkingPoints": proposed talking points, each one sentence, grounded in the context - propose, never invent commitments.
Only use the context given. If the context is thin, say so in the summary rather than filling gaps. ${untrustedDataClauseJsonSafe("workspace context")}`;

function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/** Significant words of a title: long enough to mean something, capped so a long title stays narrow. */
function titleTokens(title: string): string[] {
  return title
    .split(/[^A-Za-z0-9]+/)
    .filter((w) => w.length >= 4)
    .slice(0, 4);
}

/** Parse the model's JSON strictly; a malformed or over-cap answer is unusable, never partially applied. */
export function parseMeetingPrepAnswer(text: string): MeetingPrepDraft {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new MeetingPrepUnusableAnswerError("The model's answer was not JSON.");
  }
  const parsed = response.safeParse(raw);
  if (!parsed.success) {
    throw new MeetingPrepUnusableAnswerError("The model's answer did not match the prep shape.");
  }
  return parsed.data;
}

type AttendeeContext = { name: string; email: string | null; contact: { title: string | null; notes: string | null; relationshipStatus: string; lastInteractionAt: Date | null } | null };

async function gatherContext(auth: AuthContext, eventId: string) {
  const [event] = await db
    .select()
    .from(events)
    .where(and(eq(events.id, eventId), eq(events.workspaceId, auth.workspaceId)))
    .limit(1);
  if (!event) throw new MeetingPrepNotAllowedError("That event does not exist in this workspace.");

  const attendeeRows = await db
    .select({
      email: eventAttendees.email,
      displayName: eventAttendees.displayName,
      contactId: eventAttendees.contactId,
      fullName: contacts.fullName,
      title: contacts.title,
      notes: contacts.notes,
      relationshipStatus: contacts.relationshipStatus,
      lastInteractionAt: contacts.lastInteractionAt,
    })
    .from(eventAttendees)
    .leftJoin(contacts, and(eq(contacts.id, eventAttendees.contactId), eq(contacts.workspaceId, auth.workspaceId)))
    .where(and(eq(eventAttendees.eventId, event.id), eq(eventAttendees.workspaceId, auth.workspaceId)));

  const attendees: AttendeeContext[] = attendeeRows.map((row) => ({
    name: row.fullName ?? row.displayName ?? row.email ?? "Unknown attendee",
    email: row.email,
    contact: row.contactId
      ? { title: row.title, notes: row.notes, relationshipStatus: row.relationshipStatus ?? "unknown", lastInteractionAt: row.lastInteractionAt }
      : null,
  }));

  // Past notes and open loops are matched on what is actually on the event:
  // attendee names plus the significant words of its title. Nothing wider.
  const needles = [...attendees.map((a) => a.name).filter((n) => n !== "Unknown attendee"), ...titleTokens(event.title)];

  const pastNotes =
    needles.length === 0
      ? []
      : await db
          .select({ title: artifacts.title, snippet: sql<string>`left(${artifactVersions.plainText}, 500)` })
          .from(artifacts)
          .innerJoin(artifactVersions, eq(artifactVersions.id, artifacts.currentVersionId))
          .where(
            and(
              eq(artifacts.workspaceId, auth.workspaceId),
              ne(artifacts.status, "archived"),
              isNotNull(artifactVersions.plainText),
              or(...needles.map((n) => ilike(artifactVersions.plainText, `%${escapeLike(n)}%`))),
            ),
          )
          .limit(PREP_MAX_NOTES);

  const openTasks =
    needles.length === 0
      ? []
      : await db
          .select({ title: tasks.title, status: tasks.status, dueAt: tasks.dueAt })
          .from(tasks)
          .where(
            and(
              eq(tasks.workspaceId, auth.workspaceId),
              inArray(tasks.status, ["inbox", "backlog", "ready", "in_progress", "waiting"]),
              or(
                ...needles.flatMap((n) => {
                  const pat = `%${escapeLike(n)}%`;
                  return [ilike(tasks.title, pat), sql`${tasks.description} is not null and ${tasks.description} ilike ${pat}`];
                }),
              ),
            ),
          )
          .limit(PREP_MAX_TASKS);

  return { event, attendees, pastNotes, openTasks };
}

function contextPrompt(ctx: Awaited<ReturnType<typeof gatherContext>>): string {
  const lines: string[] = [];
  lines.push(`EVENT: ${ctx.event.title}`);
  if (ctx.event.description) lines.push(`DESCRIPTION: ${ctx.event.description}`);
  if (ctx.event.location) lines.push(`LOCATION: ${ctx.event.location}`);
  lines.push(`WHEN: ${ctx.event.startsAt.toISOString()} to ${ctx.event.endsAt.toISOString()}`);
  lines.push("");
  lines.push("ATTENDEES:");
  for (const a of ctx.attendees) {
    const parts = [`- ${a.name}${a.email ? ` <${a.email}>` : ""}`];
    if (a.contact) {
      if (a.contact.title) parts.push(`title: ${a.contact.title}`);
      parts.push(`relationship: ${a.contact.relationshipStatus}`);
      if (a.contact.lastInteractionAt) parts.push(`last interaction: ${a.contact.lastInteractionAt.toISOString().slice(0, 10)}`);
      if (a.contact.notes) parts.push(`notes: ${a.contact.notes}`);
    } else {
      parts.push("(no contact record)");
    }
    lines.push(parts.join("; "));
  }
  lines.push("");
  lines.push("PAST NOTES THAT MENTION THEM OR THIS TOPIC:");
  if (ctx.pastNotes.length === 0) lines.push("- none");
  for (const n of ctx.pastNotes) lines.push(`- ${n.title}: ${n.snippet ?? ""}`);
  lines.push("");
  lines.push("OPEN TASKS THAT MENTION THEM OR THIS TOPIC:");
  if (ctx.openTasks.length === 0) lines.push("- none");
  for (const t of ctx.openTasks) lines.push(`- [${t.status}] ${t.title}${t.dueAt ? ` (due ${t.dueAt.toISOString().slice(0, 10)})` : ""}`);
  const prompt = lines.join("\n");
  return prompt.slice(0, PREP_MAX_CONTEXT_CHARS);
}

function renderReport(ctx: Awaited<ReturnType<typeof gatherContext>>, draft: MeetingPrepDraft): string {
  const md: string[] = [];
  md.push(`# Prep: ${ctx.event.title}`);
  md.push("");
  md.push(`*${ctx.event.startsAt.toISOString().slice(0, 16).replace("T", " ")} - generated from workspace context. Talking points are proposals, not commitments.*`);
  md.push("");
  md.push("## Summary");
  md.push(draft.summary);
  if (draft.attendeeBriefs?.length) {
    md.push("", "## Who");
    for (const b of draft.attendeeBriefs) md.push(`- **${b.name}** - ${b.brief}`);
  }
  if (draft.history) md.push("", "## Relevant history", draft.history);
  if (draft.openLoops) md.push("", "## Open loops", draft.openLoops);
  md.push("", "## Proposed talking points");
  for (const point of draft.talkingPoints) md.push(`- ${point}`);
  return md.join("\n");
}

export type MeetingPrepResult = {
  eventId: string;
  artifactId: string;
  attendeeCount: number;
  pastNoteCount: number;
  openTaskCount: number;
};

export async function generateMeetingPrep(
  auth: AuthContext,
  eventId: string,
  deps?: { provider?: GenerationProvider },
): Promise<MeetingPrepResult> {
  const ctx = await gatherContext(auth, eventId);

  let provider: GenerationProvider;
  try {
    provider = deps?.provider ?? generationProvider(process.env);
  } catch (error) {
    if (error instanceof GenerationUnconfiguredError) throw new MeetingPrepNotAllowedError(error.message);
    throw error;
  }

  const out = await provider.generate({ system: SYSTEM, prompt: contextPrompt(ctx), json: true });
  const draft = parseMeetingPrepAnswer(out.text);
  const markdown = renderReport(ctx, draft);

  const artifactId = await withTransaction(async (tx) => {
    const note = await createNoteInTx(tx, auth, {
      title: `Prep: ${ctx.event.title}`,
      kind: "report",
      plainText: markdown,
    });
    // Link the report back to the event; one prep link per event, refreshed
    // on regeneration so the event always points at the latest report.
    await tx
      .delete(eventLinks)
      .where(and(eq(eventLinks.eventId, ctx.event.id), eq(eventLinks.targetType, "artifact"), eq(eventLinks.label, "Meeting prep")));
    await tx.insert(eventLinks).values({
      workspaceId: auth.workspaceId,
      eventId: ctx.event.id,
      targetType: "artifact",
      targetId: note.id,
      label: "Meeting prep",
    });
    await recordAudit(
      auth,
      {
        action: "meeting.prep_generated",
        subjectType: "event",
        subjectId: ctx.event.id,
        summary: `Generated a prep report for "${ctx.event.title}".`,
        metadata: {
          artifactId: note.id,
          attendees: ctx.attendees.length,
          pastNotes: ctx.pastNotes.length,
          openTasks: ctx.openTasks.length,
          proposer: provider.name,
        },
      },
      tx,
    );
    return note.id;
  });

  return {
    eventId,
    artifactId,
    attendeeCount: ctx.attendees.length,
    pastNoteCount: ctx.pastNotes.length,
    openTaskCount: ctx.openTasks.length,
  };
}
