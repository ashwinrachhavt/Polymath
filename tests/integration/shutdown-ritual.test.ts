import { and, eq, ne } from "drizzle-orm";
import type { drizzle } from "drizzle-orm/postgres-js";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { outboxEvents } from "@/domains/audit/schema";
import { captures } from "@/domains/capture/schema";
import { dayArtifactPins } from "@/domains/daybook/schema";
import { focusSessions } from "@/domains/focus/schema";
import { artifacts } from "@/domains/knowledge/schema";
import { actionAttempts, actionProposals, actionRevisions } from "@/domains/actions/schema";
import { externalAccounts } from "@/domains/integrations/schema";
import { briefingSeeds, tasks } from "@/domains/work/schema";
import { seedTaskWithNote } from "../helpers/task-note";
import { makeTestDb, ownerAuth, seedWorkspace } from "../helpers/test-workspace";

/*
 * The end-of-day shutdown (ASH-305) against real Postgres: explicit session
 * choices, state-preserving parking, briefing seeds that are suggestions and
 * not commitments, one atomic idempotent apply, and an email that can only
 * ever become a proposal. Skipped without TEST_DATABASE_URL (CI provides it).
 */

// The domain modules under test read the module-level db and withTransaction;
// point both at the test database (same holder pattern as semantic-relations).
const holder: { db: ReturnType<typeof drizzle> | undefined } = { db: undefined };
vi.mock("@/lib/db", () => ({
  get db() {
    return holder.db;
  },
}));
vi.mock("@/lib/db-transaction", () => ({
  get withTransaction() {
    return (fn: Parameters<typeof import("@/lib/db-transaction").withTransaction>[0]) =>
      (holder.db!.transaction as typeof import("@/lib/db-transaction").withTransaction)(fn);
  },
}));

const handle = makeTestDb();
const suite = handle ? describe : describe.skip;
let db: NonNullable<typeof handle>["db"];
let shutdown: typeof import("@/domains/daybook/shutdown");
let parking: typeof import("@/domains/capture/parking");
let focus: typeof import("@/domains/focus/commands");
let enrichment: typeof import("@/domains/capture/enrichment-handler");

beforeAll(async () => {
  if (!handle) return;
  ({ db } = handle);
  holder.db = handle.db;
  shutdown = await import("@/domains/daybook/shutdown");
  parking = await import("@/domains/capture/parking");
  focus = await import("@/domains/focus/commands");
  enrichment = await import("@/domains/capture/enrichment-handler");
});

afterEach(() => {
  vi.unstubAllGlobals();
});

afterAll(async () => {
  await handle?.client.end();
});

async function workspace(tag: string) {
  const { userId, workspaceId } = await seedWorkspace(db, `shutdown-${tag}-${Date.now()}`);
  return { auth: ownerAuth(userId, workspaceId), workspaceId, userId };
}

async function capture(workspaceId: string, over: Partial<typeof captures.$inferInsert> = {}) {
  const [row] = await db
    .insert(captures)
    .values({ workspaceId, kind: "text", captureMode: "authored", rawPayload: { text: "a thought" }, text: "a thought", ...over })
    .returning();
  return row;
}

async function task(workspaceId: string, title: string, over: Partial<typeof tasks.$inferInsert> = {}) {
  const { title: _dropped, ...rest } = over as { title?: string };
  return seedTaskWithNote(db, { workspaceId, title, rank: "m", status: "ready", ...rest });
}

const key = () => crypto.randomUUID();

suite("shutdown ritual", () => {
  it("refuses to apply while a live session has no explicit choice, and changes nothing", async () => {
    const { auth, workspaceId } = await workspace("choice");
    const session = await focus.startFocusSession(auth, { subject: "deep work" });
    const cap = await capture(workspaceId);
    await expect(
      shutdown.applyShutdown(auth, { idempotencyKey: key(), park: [{ captureId: cap.id, expectedVersion: cap.version }], seedTaskIds: [] }),
    ).rejects.toMatchObject({ code: "shutdown_incomplete" });
    const [after] = await db.select().from(focusSessions).where(eq(focusSessions.id, session.id));
    expect(after.state).toBe("running");
    const [capAfter] = await db.select().from(captures).where(eq(captures.id, cap.id));
    expect(capAfter.parkedAt).toBeNull();
  });

  it("finishes, abandons or leaves the live session as chosen, never inventing an outcome", async () => {
    for (const action of ["finish", "abandon", "leave"] as const) {
      const { auth } = await workspace(`session-${action}`);
      const session = await focus.startFocusSession(auth, { subject: "write" });
      const result = await shutdown.applyShutdown(auth, {
        idempotencyKey: key(),
        session:
          action === "finish"
            ? { sessionId: session.id, expectedVersion: session.version, action }
            : { sessionId: session.id, expectedVersion: session.version, action },
        park: [],
        seedTaskIds: [],
      });
      expect(result.session).toEqual({ id: session.id, action });
      const [row] = await db.select().from(focusSessions).where(eq(focusSessions.id, session.id));
      if (action === "finish") {
        expect(row.state).toBe("finished");
        expect(row.outcome).toBeNull();
      } else if (action === "abandon") {
        expect(row.state).toBe("abandoned");
      } else {
        expect(row.state).toBe("running");
        expect(row.endedAt).toBeNull();
      }
    }
  });

  it("leaves planned sessions untouched", async () => {
    const { auth, workspaceId } = await workspace("planned");
    const cap = await capture(workspaceId);
    const planned = await focus.scheduleSessionFromCapture(auth, { captureId: cap.id, scheduledAt: new Date(Date.now() + 3_600_000) });
    await shutdown.applyShutdown(auth, { idempotencyKey: key(), park: [], seedTaskIds: [] });
    const [row] = await db.select().from(focusSessions).where(eq(focusSessions.id, planned.sessionId));
    expect(row.state).toBe("paused");
    expect(row.startedAt).toBeNull();
    expect(row.scheduledAt).not.toBeNull();
  });

  it("rolls everything back when one choice is stale: session, parks, seeds and log all stay unchanged", async () => {
    const { auth, workspaceId } = await workspace("atomic");
    const session = await focus.startFocusSession(auth, { subject: "atomic" });
    const good = await capture(workspaceId);
    const stale = await capture(workspaceId);
    await expect(
      shutdown.applyShutdown(auth, {
        idempotencyKey: key(),
        session: { sessionId: session.id, expectedVersion: session.version, action: "finish", outcome: "done" },
        park: [
          { captureId: good.id, expectedVersion: good.version },
          { captureId: stale.id, expectedVersion: stale.version + 7 },
        ],
        seedTaskIds: [],
      }),
    ).rejects.toMatchObject({ code: "stale_write" });
    const [s] = await db.select().from(focusSessions).where(eq(focusSessions.id, session.id));
    expect(s.state).toBe("running");
    const [g] = await db.select().from(captures).where(eq(captures.id, good.id));
    expect(g.parkedAt).toBeNull();
    const notes = await db.select().from(artifacts).where(eq(artifacts.workspaceId, workspaceId));
    expect(notes).toHaveLength(0);
  });

  it("finishing a task-linked session through shutdown enqueues the follow-up event in the same transaction", async () => {
    const { auth, workspaceId } = await workspace("followup");
    const linked = await task(workspaceId, "Ship it");
    const session = await focus.startFocusSession(auth, { taskId: linked.id, subject: "ship" });
    await shutdown.applyShutdown(auth, {
      idempotencyKey: key(),
      session: { sessionId: session.id, expectedVersion: session.version, action: "finish", outcome: "shipped" },
      park: [],
      seedTaskIds: [],
    });
    const events = await db
      .select()
      .from(outboxEvents)
      .where(and(eq(outboxEvents.workspaceId, workspaceId), eq(outboxEvents.topic, "focus.follow_up_requested")));
    expect(events).toHaveLength(1);
  });

  it("replaying the same key returns the first result and changes nothing; a different request under it conflicts", async () => {
    const { auth, workspaceId } = await workspace("replay");
    const cap = await capture(workspaceId);
    const t = await task(workspaceId, "Carry me");
    const input = { idempotencyKey: key(), park: [{ captureId: cap.id, expectedVersion: cap.version }], seedTaskIds: [t.id] };
    const first = await shutdown.applyShutdown(auth, input);
    const second = await shutdown.applyShutdown(auth, input);
    expect(second).toEqual(first);
    // The workspace's artifacts are the task's own note (a task is a note plus an
    // extension row) and the shutdown log. A replay must not write a second log.
    const logs = await db
      .select()
      .from(artifacts)
      .where(and(eq(artifacts.workspaceId, workspaceId), eq(artifacts.id, first.logNoteId)));
    expect(logs).toHaveLength(1);
    expect(
      await db.select().from(artifacts).where(and(eq(artifacts.workspaceId, workspaceId), ne(artifacts.id, t.noteId!))),
    ).toHaveLength(1);
    expect(await db.select().from(briefingSeeds).where(eq(briefingSeeds.workspaceId, workspaceId))).toHaveLength(1);
    await expect(shutdown.applyShutdown(auth, { ...input, seedTaskIds: [] })).rejects.toMatchObject({ code: "idempotency_conflict" });
  });

  it("writes the log as a note pinned to the local day", async () => {
    const { auth, workspaceId } = await workspace("log");
    const result = await shutdown.applyShutdown(auth, { idempotencyKey: key(), park: [], seedTaskIds: [] });
    const [pin] = await db.select().from(dayArtifactPins).where(eq(dayArtifactPins.workspaceId, workspaceId));
    expect(pin.artifactId).toBe(result.logNoteId);
    expect(pin.localDate).toBe(result.today);
  });

  describe("parking", () => {
    it("hides a parked capture from the to-clarify queue and restores it exactly, without re-running enrichment", async () => {
      const { auth, workspaceId } = await workspace("park-enriched");
      const cap = await capture(workspaceId, { processingState: "enriched", title: "Reading", domain: "systems" });
      const parked = await parking.parkCapture(auth, { captureId: cap.id, expectedVersion: cap.version });
      const queries = await import("@/domains/capture/queries");
      expect((await queries.listCaptures(auth, "unprocessed")).map((c) => c.id)).not.toContain(cap.id);
      expect((await queries.listCaptures(auth, "parked")).map((c) => c.id)).toContain(cap.id);
      expect((await queries.countInboxTabs(auth)).parked).toBe(1);

      await parking.unparkCapture(auth, { captureId: cap.id, expectedVersion: parked.version });
      const [back] = await db.select().from(captures).where(eq(captures.id, cap.id));
      expect(back.parkedAt).toBeNull();
      expect(back.processingState).toBe("enriched");
      expect(back.title).toBe("Reading");
      expect(back.domain).toBe("systems");
      const events = await db.select().from(outboxEvents).where(eq(outboxEvents.workspaceId, workspaceId));
      expect(events).toHaveLength(0);
    });

    it("an enrichment event that fires while parked does nothing; unpark re-queues the paused work exactly once", async () => {
      const { auth, workspaceId } = await workspace("park-skip");
      const cap = await capture(workspaceId, { processingState: "unprocessed" });
      const parked = await parking.parkCapture(auth, { captureId: cap.id, expectedVersion: cap.version });
      const guard = new Proxy({}, { get: () => { throw new Error("enrichment ran on a parked capture"); } });
      await enrichment.runCaptureEnrichment(
        { id: crypto.randomUUID(), workspaceId, topic: "capture.enrichment_requested", payload: { captureId: cap.id } } as never,
        { judger: guard as never },
      );
      const [still] = await db.select().from(captures).where(eq(captures.id, cap.id));
      expect(still.processingState).toBe("unprocessed");

      const unparked = await parking.unparkCapture(auth, { captureId: cap.id, expectedVersion: parked.version });
      const queued = await db.select().from(outboxEvents).where(and(eq(outboxEvents.workspaceId, workspaceId), eq(outboxEvents.topic, "capture.enrichment_requested")));
      expect(queued).toHaveLength(1);
      expect(queued[0].dispatchKey).toBe(`capture-enrichment:${cap.id}:unpark-v${unparked.version}`);
    });

    it("does not duplicate an enrichment event that is still pending and unclaimed", async () => {
      const { auth, workspaceId } = await workspace("park-pending");
      const cap = await capture(workspaceId, { processingState: "unprocessed" });
      await db.insert(outboxEvents).values({ workspaceId, topic: "capture.enrichment_requested", payload: { captureId: cap.id }, dispatchKey: `capture-enrichment:${cap.id}` });
      const parked = await parking.parkCapture(auth, { captureId: cap.id, expectedVersion: cap.version });
      await parking.unparkCapture(auth, { captureId: cap.id, expectedVersion: parked.version });
      const queued = await db.select().from(outboxEvents).where(eq(outboxEvents.workspaceId, workspaceId));
      expect(queued).toHaveLength(1);
    });

    it("refuses converted or archived captures, stale versions and double-parks; scopes to the workspace", async () => {
      const a = await workspace("park-a");
      const b = await workspace("park-b");
      const converted = await capture(a.workspaceId, { processingState: "converted" });
      await expect(parking.parkCapture(a.auth, { captureId: converted.id, expectedVersion: converted.version })).rejects.toMatchObject({ code: "stale_write" });
      const cap = await capture(a.workspaceId);
      await expect(parking.parkCapture(a.auth, { captureId: cap.id, expectedVersion: cap.version + 1 })).rejects.toMatchObject({ code: "stale_write" });
      await expect(parking.parkCapture(b.auth, { captureId: cap.id, expectedVersion: cap.version })).rejects.toMatchObject({ code: "stale_write" });
      const parked = await parking.parkCapture(a.auth, { captureId: cap.id, expectedVersion: cap.version });
      await expect(parking.parkCapture(a.auth, { captureId: cap.id, expectedVersion: parked.version })).rejects.toMatchObject({ code: "stale_write" });
    });
  });

  describe("briefing seeds", () => {
    it("writes one seed per chosen task, scopes to the workspace, and never writes a daily outcome", async () => {
      const a = await workspace("seed-a");
      const b = await workspace("seed-b");
      const carried = await task(a.workspaceId, "Carried over", { rank: "z" });
      const foreign = await task(b.workspaceId, "Not yours");
      await expect(shutdown.applyShutdown(a.auth, { idempotencyKey: key(), park: [], seedTaskIds: [foreign.id] })).rejects.toMatchObject({ code: "stale_write" });
      const result = await shutdown.applyShutdown(a.auth, { idempotencyKey: key(), park: [], seedTaskIds: [carried.id] });
      // The seed row itself is the contract now: getBriefing, which used to
      // consume it and order the next day's suggestions, was removed with the
      // outcome machinery. One row for the chosen task, on the next local day.
      const rows = await db.select().from(briefingSeeds).where(eq(briefingSeeds.workspaceId, a.workspaceId));
      expect(rows).toHaveLength(1);
      expect(rows[0].taskId).toBe(carried.id);
      expect(rows[0].onDate).toBe(result.tomorrow);
      expect(await db.select().from(briefingSeeds).where(eq(briefingSeeds.workspaceId, b.workspaceId))).toHaveLength(0);
    });

    it("never resurrects a dismissed seed on replay, and disappears with a deleted task", async () => {
      const { auth, workspaceId } = await workspace("seed-dismiss");
      const t = await task(workspaceId, "Dismiss me");
      const first = await shutdown.applyShutdown(auth, { idempotencyKey: key(), park: [], seedTaskIds: [t.id] });
      await db.update(briefingSeeds).set({ archivedAt: new Date() }).where(eq(briefingSeeds.workspaceId, workspaceId));
      const again = await shutdown.applyShutdown(auth, { idempotencyKey: key(), park: [], seedTaskIds: [t.id] });
      expect(again.seeded).toBe(0);
      const rows = await db.select().from(briefingSeeds).where(eq(briefingSeeds.workspaceId, workspaceId));
      expect(rows).toHaveLength(1);
      expect(rows[0].archivedAt).not.toBeNull();
      expect(first.tomorrow).toBe(rows[0].onDate);
      await db.delete(tasks).where(eq(tasks.id, t.id));
      expect(await db.select().from(briefingSeeds).where(eq(briefingSeeds.workspaceId, workspaceId))).toHaveLength(0);
    });

    it("refuses finished or cancelled tasks", async () => {
      const { auth, workspaceId } = await workspace("seed-done");
      const done = await task(workspaceId, "Already done", { status: "done" });
      await expect(shutdown.applyShutdown(auth, { idempotencyKey: key(), park: [], seedTaskIds: [done.id] })).rejects.toMatchObject({ code: "stale_write" });
    });
  });

  describe("email", () => {
    it("is not requested by default and creates no proposal", async () => {
      const { auth, workspaceId } = await workspace("email-none");
      const result = await shutdown.applyShutdown(auth, { idempotencyKey: key(), park: [], seedTaskIds: [] });
      expect(result.email).toEqual({ status: "not_requested" });
      expect(await db.select().from(actionProposals).where(eq(actionProposals.workspaceId, workspaceId))).toHaveLength(0);
    });

    it("is skipped with a reason, never guessed, when no connected Gmail account resolves", async () => {
      const { auth, workspaceId } = await workspace("email-skip");
      const result = await shutdown.applyShutdown(auth, { idempotencyKey: key(), park: [], seedTaskIds: [], email: { to: "me@example.com", accountAlias: null } });
      expect(result.email.status).toBe("skipped");
      expect(await db.select().from(actionProposals).where(eq(actionProposals.workspaceId, workspaceId))).toHaveLength(0);
    });

    it("rejects a recipient that is not an address", async () => {
      const { auth } = await workspace("email-bad");
      await expect(
        shutdown.applyShutdown(auth, { idempotencyKey: key(), park: [], seedTaskIds: [], email: { to: "not an address", accountAlias: null } }),
      ).rejects.toMatchObject({ code: "shutdown_incomplete" });
    });
  });

  describe("email with a connected account", () => {
    async function connect(workspaceId: string, userId: string, alias: string, accessTier: string, disabledCapabilities: string[] = []) {
      await db.insert(externalAccounts).values({
        workspaceId,
        provider: "gmail",
        alias,
        status: "active",
        accessTier,
        disabledCapabilities,
        composioConnectedAccountId: `ca_${crypto.randomUUID()}`,
        createdBy: userId,
        updatedBy: userId,
      });
    }
    const providerSpy = () => {
      const spy = vi.fn(async () => new Response("{}", { status: 200 }));
      vi.stubGlobal("fetch", spy);
      return spy;
    };

    it("files a pending proposal pinned to the account, sends nothing, and replays to the same proposal", async () => {
      const { auth, workspaceId, userId } = await workspace("email-ok");
      await connect(workspaceId, userId, "work", "read_send");
      const spy = providerSpy();
      const input = { idempotencyKey: key(), park: [], seedTaskIds: [], email: { to: "me@example.com", accountAlias: "work" } };
      const first = await shutdown.applyShutdown(auth, input);
      expect(first.email.status).toBe("proposed");
      const replay = await shutdown.applyShutdown(auth, input);
      expect(replay.email).toEqual(first.email);

      const proposals = await db.select().from(actionProposals).where(eq(actionProposals.workspaceId, workspaceId));
      expect(proposals).toHaveLength(1);
      expect(proposals[0]).toMatchObject({ capability: "gmail.send", status: "pending", accountAlias: "work" });
      const revisions = await db.select().from(actionRevisions).where(eq(actionRevisions.proposalId, proposals[0].id));
      expect(revisions).toHaveLength(1);
      expect(revisions[0].payload).toMatchObject({ to: "me@example.com", accountPin: { resolved: true, alias: "work" } });
      expect(await db.select().from(actionAttempts).where(eq(actionAttempts.workspaceId, workspaceId))).toHaveLength(0);
      expect(spy).not.toHaveBeenCalled();
    });

    it("a revised recipient under a new key is a new proposal; under the same key it conflicts", async () => {
      const { auth, workspaceId, userId } = await workspace("email-revise");
      await connect(workspaceId, userId, "work", "read_send");
      const spy = providerSpy();
      const firstKey = key();
      await shutdown.applyShutdown(auth, { idempotencyKey: firstKey, park: [], seedTaskIds: [], email: { to: "first@example.com", accountAlias: "work" } });
      await expect(
        shutdown.applyShutdown(auth, { idempotencyKey: firstKey, park: [], seedTaskIds: [], email: { to: "second@example.com", accountAlias: "work" } }),
      ).rejects.toMatchObject({ code: "idempotency_conflict" });
      await shutdown.applyShutdown(auth, { idempotencyKey: key(), park: [], seedTaskIds: [], email: { to: "second@example.com", accountAlias: "work" } });
      const recipients = (
        await db.select().from(actionRevisions).where(eq(actionRevisions.workspaceId, workspaceId))
      ).map((r) => (r.payload as { to: string }).to);
      expect(recipients.sort()).toEqual(["first@example.com", "second@example.com"]);
      expect(spy).not.toHaveBeenCalled();
    });

    it("an email-only repeat after closing is a deliberate ask: a new proposal, not a silent replay", async () => {
      const { auth, workspaceId, userId } = await workspace("email-repeat");
      await connect(workspaceId, userId, "work", "read_send");
      providerSpy();
      const first = await shutdown.applyShutdown(auth, { idempotencyKey: key(), park: [], seedTaskIds: [], email: { to: "first@example.com", accountAlias: "work" } });
      expect(first.email.status).toBe("proposed");
      // Fresh key, a revised recipient and nothing else: the replay branch must
      // not swallow the explicit ask - it files its own proposal and log line.
      const second = await shutdown.applyShutdown(auth, { idempotencyKey: key(), park: [], seedTaskIds: [], email: { to: "second@example.com", accountAlias: "work" } });
      expect(second.replayed).toBe(false);
      expect(second.email.status).toBe("proposed");
      const proposals = await db.select().from(actionProposals).where(eq(actionProposals.workspaceId, workspaceId));
      expect(proposals).toHaveLength(2);
    });

    it("files nothing when the connection's tier or Send switch does not allow sending", async () => {
      const readOnly = await workspace("email-readonly");
      await connect(readOnly.workspaceId, readOnly.userId, "work", "read_only");
      const off = await workspace("email-switch-off");
      await connect(off.workspaceId, off.userId, "work", "read_send", ["gmail.send"]);
      for (const { auth, workspaceId } of [readOnly, off]) {
        const result = await shutdown.applyShutdown(auth, { idempotencyKey: key(), park: [], seedTaskIds: [], email: { to: "me@example.com", accountAlias: "work" } });
        expect(result.email).toMatchObject({ status: "skipped" });
        expect(await db.select().from(actionProposals).where(eq(actionProposals.workspaceId, workspaceId))).toHaveLength(0);
      }
    });
  });

  describe("repeat applies (ASH-323)", () => {
    it("a remounted no-effect apply replays the day's log instead of duplicating it", async () => {
      const { auth, workspaceId } = await workspace("replay-remount");
      const cap = await capture(workspaceId);
      const first = await shutdown.applyShutdown(auth, { idempotencyKey: key(), park: [{ captureId: cap.id, expectedVersion: cap.version }], seedTaskIds: [] });
      expect(first.replayed).toBe(false);
      // A remount gets a fresh render: a new idempotency key, empty selections.
      const again = await shutdown.applyShutdown(auth, { idempotencyKey: key(), park: [], seedTaskIds: [] });
      expect(again.replayed).toBe(true);
      expect(again.logNoteId).toBe(first.logNoteId);
      expect(again.session).toBeNull();
      expect(again.parked).toBe(0);
      expect(again.seeded).toBe(0);
      expect(await db.select().from(artifacts).where(eq(artifacts.workspaceId, workspaceId))).toHaveLength(1);
      expect(await db.select().from(dayArtifactPins).where(eq(dayArtifactPins.workspaceId, workspaceId))).toHaveLength(1);
    });

    it("a deliberate repeat with a new effect still applies it and writes its own log", async () => {
      const { auth, workspaceId } = await workspace("repeat-deliberate");
      const first = await shutdown.applyShutdown(auth, { idempotencyKey: key(), park: [], seedTaskIds: [] });
      const cap = await capture(workspaceId);
      const second = await shutdown.applyShutdown(auth, { idempotencyKey: key(), park: [{ captureId: cap.id, expectedVersion: cap.version }], seedTaskIds: [] });
      expect(second.replayed).toBe(false);
      expect(second.parked).toBe(1);
      expect(second.logNoteId).not.toBe(first.logNoteId);
      const [after] = await db.select().from(captures).where(eq(captures.id, cap.id));
      expect(after.parkedAt).not.toBeNull();
    });

    it("concurrent fresh-key empty applies cannot duplicate the day's log", async () => {
      const { auth, workspaceId } = await workspace("replay-race");
      const [a, b] = await Promise.all([
        shutdown.applyShutdown(auth, { idempotencyKey: key(), park: [], seedTaskIds: [] }),
        shutdown.applyShutdown(auth, { idempotencyKey: key(), park: [], seedTaskIds: [] }),
      ]);
      expect([a.replayed, b.replayed].sort()).toEqual([false, true]);
      expect(a.logNoteId).toBe(b.logNoteId);
      expect(await db.select().from(artifacts).where(eq(artifacts.workspaceId, workspaceId))).toHaveLength(1);
      expect(await db.select().from(dayArtifactPins).where(eq(dayArtifactPins.workspaceId, workspaceId))).toHaveLength(1);
    });

    it("the preview reports the already-closed day so a remount shows the saved confirmation", async () => {
      const { auth } = await workspace("preview-closed");
      expect((await shutdown.previewShutdown(auth)).closedLog).toBeNull();
      const result = await shutdown.applyShutdown(auth, { idempotencyKey: key(), park: [], seedTaskIds: [] });
      const preview = await shutdown.previewShutdown(auth);
      expect(preview.closedLog).toEqual({ id: result.logNoteId, title: `Shutdown log ${result.today}` });
    });
  });
});
