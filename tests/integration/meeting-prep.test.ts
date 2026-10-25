import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { calendars, eventAttendees, eventLinks, events } from "@/domains/calendar/schema";
import { contacts } from "@/domains/crm/schema";
import { artifacts, artifactVersions } from "@/domains/knowledge/schema";
import { tasks } from "@/domains/work/schema";
import { makeTestDb, ownerAuth, seedWorkspace } from "../helpers/test-workspace";

/*
 * Meeting prep (ASH-302), end to end against a scratch database:
 *  1. an event's attendees, the notes that mention them, and the open loops
 *     are gathered into one prompt, and the answer becomes a linked report
 *     artifact;
 *  2. regeneration replaces the event's prep link with the newest report;
 *  3. an unknown event refuses before any write;
 *  4. an unusable model answer writes nothing.
 *
 * The generation provider is a mock. Skipped unless TEST_DATABASE_URL points
 * at a migrated scratch database.
 */

const DRAFT = JSON.stringify({
  summary: "Weekly sync with Priya Nair about the Q3 roadmap.",
  attendeeBriefs: [{ name: "Priya Nair", brief: "Platform lead; asked for the roadmap by Friday." }],
  history: "The pricing-decision note records that annual billing stays.",
  openLoops: "Send the Q3 roadmap is still open.",
  talkingPoints: ["Confirm the launch date", "Share the Q3 roadmap draft"],
});

const mockProvider = { name: "test:mock", registryId: "mock", generate: async () => ({ text: DRAFT }) };

const handle = makeTestDb();
const suite = handle ? describe : describe.skip;
let db: NonNullable<typeof handle>["db"];
let prep: typeof import("@/domains/knowledge/meeting-prep");

beforeAll(async () => {
  if (!handle) return;
  ({ db } = handle);
  prep = await import("@/domains/knowledge/meeting-prep");
});

afterAll(async () => {
  await handle?.client.end();
});

async function seed(slug: string) {
  const { userId, workspaceId } = await seedWorkspace(db, `${slug}-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`);
  return { auth: ownerAuth(userId, workspaceId), userId, workspaceId };
}

async function seedEvent(workspaceId: string, userId: string) {
  const [calendar] = await db
    .insert(calendars)
    .values({ workspaceId, name: "Primary", kind: "local", createdBy: userId, updatedBy: userId })
    .returning();
  const [event] = await db
    .insert(events)
    .values({
      workspaceId,
      calendarId: calendar.id,
      title: "Weekly sync",
      startsAt: new Date("2026-10-26T17:00:00Z"),
      endsAt: new Date("2026-10-26T17:30:00Z"),
      createdBy: userId,
      updatedBy: userId,
    })
    .returning();
  return event;
}

async function seedFullContext(workspaceId: string, userId: string, eventId: string) {
  const [contact] = await db
    .insert(contacts)
    .values({ workspaceId, fullName: "Priya Nair", primaryEmail: "priya@example.com", title: "Platform lead", createdBy: userId, updatedBy: userId })
    .returning();
  await db.insert(eventAttendees).values({ workspaceId, eventId, email: "priya@example.com", displayName: "Priya Nair", contactId: contact.id });

  const [note] = await db
    .insert(artifacts)
    .values({ workspaceId, kind: "note", title: "Pricing decision", status: "reviewed", createdBy: userId, updatedBy: userId })
    .returning();
  const [v1] = await db
    .insert(artifactVersions)
    .values({
      workspaceId,
      artifactId: note.id,
      versionNumber: 1,
      content: { type: "doc", content: [] },
      plainText: "Decided with Priya Nair: annual billing stays for the platform tier.",
      reason: "created",
      createdBy: userId,
    })
    .returning();
  await db.update(artifacts).set({ currentVersionId: v1.id }).where(eq(artifacts.id, note.id));

  await db.insert(tasks).values({ workspaceId, title: "Send the Q3 roadmap to Priya Nair", status: "ready", createdBy: userId, updatedBy: userId });
}

suite("meeting prep", () => {
  it("gathers attendees, notes and open loops into one linked report", async () => {
    const { auth, workspaceId, userId } = await seed("prep-happy");
    const event = await seedEvent(workspaceId, userId);
    await seedFullContext(workspaceId, userId, event.id);

    const result = await prep.generateMeetingPrep(auth, event.id, { provider: mockProvider });

    expect(result.attendeeCount).toBe(1);
    expect(result.pastNoteCount).toBe(1);
    expect(result.openTaskCount).toBe(1);

    const [report] = await db.select().from(artifacts).where(eq(artifacts.id, result.artifactId));
    expect(report.kind).toBe("report");
    expect(report.title).toBe("Prep: Weekly sync");

    const [link] = await db
      .select()
      .from(eventLinks)
      .where(and(eq(eventLinks.eventId, event.id), eq(eventLinks.targetType, "artifact")));
    expect(link.targetId).toBe(result.artifactId);
    expect(link.label).toBe("Meeting prep");

    const [version] = await db.select().from(artifactVersions).where(eq(artifactVersions.id, report.currentVersionId!));
    expect(version.plainText).toContain("Confirm the launch date");
    expect(version.plainText).toContain("proposals, not commitments");
  });

  it("replaces the event's prep link with the newest report on regeneration", async () => {
    const { auth, workspaceId, userId } = await seed("prep-regen");
    const event = await seedEvent(workspaceId, userId);
    await seedFullContext(workspaceId, userId, event.id);

    const first = await prep.generateMeetingPrep(auth, event.id, { provider: mockProvider });
    const second = await prep.generateMeetingPrep(auth, event.id, { provider: mockProvider });
    expect(second.artifactId).not.toBe(first.artifactId);

    const links = await db
      .select()
      .from(eventLinks)
      .where(and(eq(eventLinks.eventId, event.id), eq(eventLinks.targetType, "artifact"), eq(eventLinks.label, "Meeting prep")));
    expect(links).toHaveLength(1);
    expect(links[0]!.targetId).toBe(second.artifactId);
  });

  it("refuses an unknown event before any write", async () => {
    const { auth, workspaceId } = await seed("prep-unknown");
    await expect(prep.generateMeetingPrep(auth, crypto.randomUUID(), { provider: mockProvider })).rejects.toThrowError(/does not exist/);
    expect(await db.select({ id: artifacts.id }).from(artifacts).where(eq(artifacts.workspaceId, workspaceId))).toHaveLength(0);
  });

  it("writes nothing when the model's answer is unusable", async () => {
    const { auth, workspaceId, userId } = await seed("prep-bad-answer");
    const event = await seedEvent(workspaceId, userId);
    const bad = { ...mockProvider, generate: async () => ({ text: "no idea" }) };
    await expect(prep.generateMeetingPrep(auth, event.id, { provider: bad })).rejects.toThrowError(/not JSON/);
    expect(await db.select({ id: artifacts.id }).from(artifacts).where(eq(artifacts.workspaceId, workspaceId))).toHaveLength(0);
    expect(await db.select({ id: eventLinks.id }).from(eventLinks).where(eq(eventLinks.eventId, event.id))).toHaveLength(0);
  });
});
