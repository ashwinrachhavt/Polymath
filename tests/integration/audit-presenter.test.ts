import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agentPrincipals } from "@/domains/agents/schema";
import { auditEvents } from "@/domains/audit/schema";
import { makeTestDb, seedWorkspace } from "../helpers/test-workspace";

/*
 * The presenter's orchestration against real Postgres: batched metadata and
 * hydration reads, per-domain entity checks over seeded rows, operation
 * folding, and the fail-closed ladder end to end through
 * listActivityEvents -> presentActivityEvents. Each test seeds its own
 * workspace, so tests stay isolated without truncation. The privacy
 * invariants carry forward from the existing suites; nothing here weakens
 * them.
 */

const handle = makeTestDb();
const suite = handle ? describe : describe.skip;
const holder: { db: ReturnType<typeof drizzle> | undefined } = { db: undefined };
vi.mock("@/lib/db", () => ({
  get db() {
    return holder.db;
  },
}));

import { presentActivityEvents } from "@/domains/audit/present";
import { listActivityEvents } from "@/domains/audit/queries";
import { artifacts } from "@/domains/knowledge/schema";
import { captures } from "@/domains/capture/schema";
import { memberships, users, workspaces } from "@/domains/identity/schema";

beforeAll(() => {
  holder.db = handle?.db;
});
afterAll(async () => {
  await handle?.client.end();
});

const authFor = async (label: string) => ({
  ...(await seedWorkspace(holder.db!, `presenter-${label}`)),
  role: "owner" as const,
});

async function seedNamedUser(displayName: string | null) {
  const [user] = await holder
    .db!.insert(users)
    .values({ clerkUserId: `tw_${crypto.randomUUID()}`, displayName })
    .returning();
  return user;
}

async function seedPrincipal(workspaceId: string, label: string) {
  const [membership] = await holder.db!.select().from(memberships).where(eq(memberships.workspaceId, workspaceId));
  const [principal] = await holder
    .db!.insert(agentPrincipals)
    .values({
      workspaceId,
      key: `principal-${crypto.randomUUID()}`,
      kind: "agent",
      label,
      ownerMembershipId: membership.id,
    })
    .returning();
  return principal;
}

async function seedCapture(workspaceId: string, title: string | null) {
  const [capture] = await holder
    .db!.insert(captures)
    .values({ workspaceId, kind: "text", rawPayload: {}, captureMode: "authored", text: "Inbox text", title })
    .returning();
  return capture;
}

async function seedNote(workspaceId: string, title: string) {
  const [artifact] = await holder.db!.insert(artifacts).values({ workspaceId, title }).returning();
  return artifact;
}

type SeedEvent = {
  action: string;
  subjectType: string;
  subjectId?: string | null;
  actorId?: string | null;
  actorKind?: "user" | "system" | "agent";
  summary: string;
  metadata?: unknown;
  operationId?: string | null;
  minutesAgo?: number;
};

async function seedEvents(workspaceId: string, actorId: string, events: SeedEvent[]) {
  const now = Date.now();
  await holder.db!.insert(auditEvents).values(
    events.map((event) => ({
      workspaceId,
      actorId: event.actorId === undefined ? actorId : event.actorId,
      actorKind: event.actorKind ?? ("user" as const),
      action: event.action,
      subjectType: event.subjectType,
      subjectId: event.subjectId ?? null,
      summary: event.summary,
      metadata: (event.metadata ?? null) as never,
      operationId: event.operationId ?? null,
      createdAt: new Date(now - (event.minutesAgo ?? 0) * 60_000),
    })),
  );
}

const sentenceOf = (items: Awaited<ReturnType<typeof presentActivityEvents>>, sentence: string) =>
  items.find((item) => item.sentence === sentence);

suite("presentActivityEvents (real Postgres)", () => {
  it("attributes actors: You, named member, unnamed member, labeled agent, unknown agent, system", async () => {
    const auth = await authFor(crypto.randomUUID());
    const named = await seedNamedUser("Alex Rivera");
    const unnamed = await seedNamedUser(null);
    const principal = await seedPrincipal(auth.workspaceId, "Nightly Briefing");
    const capture = await seedCapture(auth.workspaceId, "Inbox idea");

    await seedEvents(auth.workspaceId, auth.userId, [
      { action: "capture.created", subjectType: "capture", subjectId: capture.id, summary: "raw", minutesAgo: 5 },
      {
        action: "capture.created",
        subjectType: "capture",
        subjectId: capture.id,
        actorId: named.id,
        summary: "raw",
        minutesAgo: 4,
      },
      {
        action: "capture.created",
        subjectType: "capture",
        subjectId: capture.id,
        actorId: unnamed.id,
        summary: "raw",
        minutesAgo: 3,
      },
      {
        action: "capture.created",
        subjectType: "capture",
        subjectId: capture.id,
        actorId: principal.id,
        actorKind: "agent",
        summary: "raw",
        minutesAgo: 2,
      },
      {
        action: "capture.created",
        subjectType: "capture",
        subjectId: capture.id,
        actorId: crypto.randomUUID(),
        actorKind: "agent",
        summary: "raw",
        minutesAgo: 1,
      },
      {
        action: "capture.created",
        subjectType: "capture",
        subjectId: capture.id,
        actorId: null,
        actorKind: "system",
        summary: "raw",
        minutesAgo: 0,
      },
    ]);

    const page = await listActivityEvents(auth, { limit: 50 });
    const items = await presentActivityEvents(auth, page.rows);

    expect(items.map((item) => item.actor)).toEqual([
      { label: "Polymath", kind: "system" },
      { label: "Agent", kind: "agent" },
      { label: "Nightly Briefing", kind: "agent" },
      { label: "Workspace member", kind: "user" },
      { label: "Alex Rivera", kind: "user" },
      { label: "You", kind: "user" },
    ]);
    // Every row verified against the seeded capture, so each item carries its
    // live title and an honest destination.
    for (const item of items) {
      expect(item.title).toBe("Inbox idea");
      expect(item.primary).toEqual({ label: "Open capture", href: `/command-center/inbox?id=${capture.id}` });
    }
  });

  it("renders deleted and foreign targets as unavailable, and route-less subjects unlinked", async () => {
    const auth = await authFor(crypto.randomUUID());
    const [foreignWorkspace] = await holder
      .db!.insert(workspaces)
      .values({ name: "presenter-foreign", slug: `presenter-foreign-${crypto.randomUUID()}` })
      .returning();
    const foreignCapture = await seedCapture(foreignWorkspace.id, "Not yours");
    const deletedSubject = crypto.randomUUID();

    await seedEvents(auth.workspaceId, auth.userId, [
      { action: "capture.created", subjectType: "capture", subjectId: deletedSubject, summary: "raw", minutesAgo: 30 },
      {
        action: "capture.created",
        subjectType: "capture",
        subjectId: foreignCapture.id,
        summary: "raw",
        minutesAgo: 20,
      },
      {
        action: "note.created",
        subjectType: "artifact",
        subjectId: crypto.randomUUID(),
        summary: "raw",
        minutesAgo: 10,
      },
    ]);

    const page = await listActivityEvents(auth, { limit: 50 });
    const items = await presentActivityEvents(auth, page.rows);

    expect(items.map((item) => item.primary)).toEqual([
      null,
      { state: "unavailable", reason: "deleted" },
      { state: "unavailable", reason: "deleted" },
    ]);
    expect(items.every((item) => item.title === null)).toBe(true);
  });

  it("presents a payload-v1 conversion as one navigable story with steps", async () => {
    const auth = await authFor(crypto.randomUUID());
    const named = await seedNamedUser("Alex Rivera");
    const principal = await seedPrincipal(auth.workspaceId, "Nightly Briefing");
    const capture = await seedCapture(auth.workspaceId, "Inbox idea");
    const note = await seedNote(auth.workspaceId, "Converted note");
    const operationId = crypto.randomUUID();

    await seedEvents(auth.workspaceId, auth.userId, [
      {
        action: "capture.proposal_created",
        subjectType: "capture",
        subjectId: capture.id,
        actorId: principal.id,
        actorKind: "agent",
        summary: "raw",
        metadata: { version: 1 },
        operationId,
        minutesAgo: 12,
      },
      {
        action: "capture.proposal_accepted",
        subjectType: "capture",
        subjectId: capture.id,
        actorId: named.id,
        summary: "raw",
        metadata: { version: 1 },
        operationId,
        minutesAgo: 11,
      },
      {
        action: "capture.converted",
        subjectType: "capture",
        subjectId: capture.id,
        summary: "raw",
        metadata: {
          version: 1,
          resultType: "note",
          resultId: note.id,
          displaySnapshot: { title: "Converted note" },
        },
        operationId,
        minutesAgo: 10,
      },
    ]);

    const page = await listActivityEvents(auth, { limit: 50 });
    const items = await presentActivityEvents(auth, page.rows);

    // Three rows fold into one outcome item: the registry-designated outcome
    // leads, and both steps ride the disclosure oldest-first with their own
    // actors (the technical proposal-creation step renders its technical
    // sentence).
    expect(items).toHaveLength(1);
    const outcome = items[0];
    expect(outcome.sentence).toBe("You converted a capture");
    expect(outcome.primary).toEqual({ label: "Open note", href: `/polymath/notes?id=${note.id}` });
    expect(outcome.related).toEqual([{ label: "Open capture", href: `/command-center/inbox?id=${capture.id}` }]);
    expect(outcome.title).toBe("Converted note");
    expect(outcome.steps).toEqual(["Workspace activity recorded", "Alex Rivera accepted a capture proposal"]);
    const serialized = JSON.stringify(items);
    expect(serialized).not.toContain("proposal_created");
  });

  it("keeps a step row standalone when its outcome is off the page", async () => {
    const auth = await authFor(crypto.randomUUID());
    const capture = await seedCapture(auth.workspaceId, "Inbox idea");

    await seedEvents(auth.workspaceId, auth.userId, [
      {
        action: "capture.proposal_accepted",
        subjectType: "capture",
        subjectId: capture.id,
        summary: "raw",
        metadata: { version: 1 },
        operationId: crypto.randomUUID(),
      },
    ]);

    const page = await listActivityEvents(auth, { limit: 50 });
    const items = await presentActivityEvents(auth, page.rows);

    expect(items).toHaveLength(1);
    expect(items[0].sentence).toBe("You accepted a capture proposal");
    expect(items[0].steps).toEqual([]);
  });

  it("keeps the fail-closed ladder over stored rows: allowlisted verbatim, unlisted generic, unknown generic", async () => {
    const auth = await authFor(crypto.randomUUID());
    const capture = await seedCapture(auth.workspaceId, "Inbox idea");

    await seedEvents(auth.workspaceId, auth.userId, [
      {
        action: "capture.converted",
        subjectType: "capture",
        subjectId: capture.id,
        summary: "Capture became note: Scraped Header",
        minutesAgo: 40,
      },
      { action: "task.created", subjectType: "task", subjectId: null, summary: "should not render", minutesAgo: 30 },
      { action: "widgets.whirr", subjectType: "capture", subjectId: capture.id, summary: "anything", minutesAgo: 20 },
      {
        action: "integration.connection_failed",
        subjectType: "capture",
        subjectId: capture.id,
        summary: "Connection failed: Google as Work — Provider exploded",
        minutesAgo: 10,
      },
    ]);

    const page = await listActivityEvents(auth, { limit: 50 });
    const items = await presentActivityEvents(auth, page.rows);

    expect(sentenceOf(items, "Capture became note: Scraped Header")).toBeDefined();
    expect(sentenceOf(items, "Task created recorded")).toBeDefined();
    expect(sentenceOf(items, "Widgets whirr recorded")).toBeDefined();
    expect(sentenceOf(items, "Connection failed: Google as Work")).toBeDefined();
    expect(items.map((item) => item.sentence)).not.toContain("should not render");
    expect(items.map((item) => item.sentence)).not.toContain("Provider exploded");
    // The unknown action still resolves to the workspace technical default.
    const unknown = sentenceOf(items, "Widgets whirr recorded");
    expect(unknown?.category).toBe("workspace");
  });

  it("never carries raw metadata onto any item", async () => {
    const auth = await authFor(crypto.randomUUID());
    const capture = await seedCapture(auth.workspaceId, "Inbox idea");

    await seedEvents(auth.workspaceId, auth.userId, [
      {
        action: "capture.created",
        subjectType: "capture",
        subjectId: capture.id,
        summary: "raw",
        metadata: { version: 1, secret: "hydrant", internalNotes: "do not ship" },
        minutesAgo: 5,
      },
    ]);

    const page = await listActivityEvents(auth, { limit: 50 });
    const items = await presentActivityEvents(auth, page.rows);

    expect(items).toHaveLength(1);
    const serialized = JSON.stringify(items);
    expect(serialized).not.toContain("hydrant");
    expect(serialized).not.toContain("internalNotes");
    for (const item of items) expect("metadata" in item).toBe(false);
  });

  it("presents an empty page as no items", async () => {
    const auth = await authFor(crypto.randomUUID());
    const items = await presentActivityEvents(auth, []);
    expect(items).toEqual([]);
  });
});
