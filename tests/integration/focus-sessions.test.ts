import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { focusSessions } from "@/domains/focus/schema";
import { makeTestDb, ownerAuth, seedWorkspace } from "../helpers/test-workspace";

/*
 * Focus lifecycle integration coverage (ASH-137 A09): the durable clock
 * (start/pause banks the open stretch/resume/finish), the one-live-session
 * invariant the partial unique index enforces, stale-version and wrong-state
 * rejection, and the read projections. Domain modules are imported lazily so
 * DATABASE_URL points at the scratch database before db-transaction reads it.
 */

const handle = makeTestDb();
const suite = handle ? describe : describe.skip;
let db: NonNullable<typeof handle>["db"];
let commands: typeof import("@/domains/focus/commands");
let queries: typeof import("@/domains/focus/queries");

beforeAll(async () => {
  if (!handle) return;
  ({ db } = handle);
  commands = await import("@/domains/focus/commands");
  queries = await import("@/domains/focus/queries");
});

afterAll(async () => {
  await handle?.client.end();
});

/** Move the durable clock anchors into the past so transitions bank real seconds. */
async function backdate(sessionId: string, secondsAgo: number) {
  const past = new Date(Date.now() - secondsAgo * 1000);
  await db.update(focusSessions).set({ startedAt: past, lastResumedAt: past }).where(eq(focusSessions.id, sessionId));
}

suite("focus sessions", () => {
  it("runs the full lifecycle and banks elapsed time across pause and finish", async () => {
    const { userId, workspaceId } = await seedWorkspace(db, `focus-life-${Date.now()}`);
    const auth = ownerAuth(userId, workspaceId);

    const session = await commands.startFocusSession(auth, { subject: "Write the brief", plannedMinutes: 25 });
    expect(session.state).toBe("running");
    expect(session.version).toBe(1);

    await backdate(session.id, 60);
    const paused = await commands.pauseFocusSession(auth, { sessionId: session.id, expectedVersion: 1 });
    expect(paused.state).toBe("paused");
    expect(paused.accumulatedSeconds).toBeGreaterThanOrEqual(59);
    expect(paused.accumulatedSeconds).toBeLessThanOrEqual(65);
    const banked = paused.accumulatedSeconds;

    const resumed = await commands.resumeFocusSession(auth, { sessionId: session.id, expectedVersion: 2 });
    expect(resumed.state).toBe("running");
    expect(resumed.lastResumedAt).not.toBeNull();

    await backdate(session.id, 30);
    const finished = await commands.finishFocusSession(auth, {
      sessionId: session.id,
      expectedVersion: 3,
      outcome: "Drafted",
    });
    expect(finished.state).toBe("finished");
    expect(finished.endedAt).not.toBeNull();
    expect(finished.outcome).toBe("Drafted");
    expect(finished.accumulatedSeconds).toBeGreaterThanOrEqual(banked + 29);

    const history = await queries.listFocusHistory(auth);
    expect(history.map((h) => h.id)).toEqual([session.id]);
    expect(history[0].elapsedSeconds).toBe(finished.accumulatedSeconds);
  });

  it("refuses a second live session with a conflict, then allows one after finish", async () => {
    const { userId, workspaceId } = await seedWorkspace(db, `focus-one-${Date.now()}`);
    const auth = ownerAuth(userId, workspaceId);

    const first = await commands.startFocusSession(auth, { subject: "First" });
    await expect(commands.startFocusSession(auth, { subject: "Second" })).rejects.toThrow(commands.ConflictError);

    await commands.abandonFocusSession(auth, { sessionId: first.id, expectedVersion: 1, reason: "switched" });
    const second = await commands.startFocusSession(auth, { subject: "Second" });
    expect(second.state).toBe("running");
  });

  it("rejects stale versions and wrong-state transitions", async () => {
    const { userId, workspaceId } = await seedWorkspace(db, `focus-stale-${Date.now()}`);
    const auth = ownerAuth(userId, workspaceId);

    const session = await commands.startFocusSession(auth, { subject: "Guarded" });
    // Version the caller never saw.
    await expect(
      commands.pauseFocusSession(auth, { sessionId: session.id, expectedVersion: 9 }),
    ).rejects.toThrow(commands.StaleWriteError);
    // A finish from the correct version works...
    await commands.finishFocusSession(auth, { sessionId: session.id, expectedVersion: 1 });
    // ...and a second finish matches no running/paused row: no duplicate, no resurrection.
    await expect(
      commands.finishFocusSession(auth, { sessionId: session.id, expectedVersion: 2 }),
    ).rejects.toThrow(commands.StaleWriteError);
  });

  it("rejects the transitions the state matrix forbids", async () => {
    const { userId, workspaceId } = await seedWorkspace(db, `focus-matrix-${Date.now()}`);
    const auth = ownerAuth(userId, workspaceId);

    // running x resume: resume is only legal from paused.
    const running = await commands.startFocusSession(auth, { subject: "Running" });
    await expect(
      commands.resumeFocusSession(auth, { sessionId: running.id, expectedVersion: 1 }),
    ).rejects.toThrow(commands.StaleWriteError);
    await commands.abandonFocusSession(auth, { sessionId: running.id, expectedVersion: 1 });

    // paused x pause: no double pause entry.
    const session = await commands.startFocusSession(auth, { subject: "Pausing twice" });
    await commands.pauseFocusSession(auth, { sessionId: session.id, expectedVersion: 1 });
    await expect(
      commands.pauseFocusSession(auth, { sessionId: session.id, expectedVersion: 2 }),
    ).rejects.toThrow(commands.StaleWriteError);
    // The one live slot is still held by this paused session.
    await commands.abandonFocusSession(auth, { sessionId: session.id, expectedVersion: 2 });

    // paused x abandon: a paused session can still be abandoned, with endedAt set.
    const paused = await commands.startFocusSession(auth, { subject: "Pausing out" });
    await commands.pauseFocusSession(auth, { sessionId: paused.id, expectedVersion: 1 });
    const abandoned = await commands.abandonFocusSession(auth, {
      sessionId: paused.id,
      expectedVersion: 2,
      reason: "switched contexts",
    });
    expect(abandoned.state).toBe("abandoned");
    expect(abandoned.endedAt).not.toBeNull();

    // paused x start-rival: the one-live-session invariant holds from paused too.
    const rival = await commands.startFocusSession(auth, { subject: "Pausing rival" });
    await commands.pauseFocusSession(auth, { sessionId: rival.id, expectedVersion: 1 });
    await expect(commands.startFocusSession(auth, { subject: "Rival" })).rejects.toThrow(commands.ConflictError);
  });

  it("finishing from paused banks nothing extra", async () => {
    const { userId, workspaceId } = await seedWorkspace(db, `focus-paused-${Date.now()}`);
    const auth = ownerAuth(userId, workspaceId);

    const session = await commands.startFocusSession(auth, { subject: "Paused finish" });
    await backdate(session.id, 45);
    const paused = await commands.pauseFocusSession(auth, { sessionId: session.id, expectedVersion: 1 });
    // Wait a beat while paused; the banked total must not grow.
    await new Promise((resolve) => setTimeout(resolve, 1100));
    const finished = await commands.finishFocusSession(auth, { sessionId: session.id, expectedVersion: 2 });
    expect(finished.accumulatedSeconds).toBe(paused.accumulatedSeconds);
  });

  it("active lookup and history stay inside the caller's workspace", async () => {
    const a = await seedWorkspace(db, `focus-ten-a-${Date.now()}`);
    const b = await seedWorkspace(db, `focus-ten-b-${Date.now()}`);
    const authA = ownerAuth(a.userId, a.workspaceId);
    const authB = ownerAuth(b.userId, b.workspaceId);

    const sessionB = await commands.startFocusSession(authB, { subject: "B's session" });
    expect(await queries.getActiveFocusSession(authA)).toBeNull();
    expect((await queries.getActiveFocusSession(authB))!.id).toBe(sessionB.id);
    // Live sessions are not history.
    expect(await queries.listFocusHistory(authB)).toEqual([]);
    expect(await queries.listFocusHistory(authA)).toEqual([]);

    await commands.abandonFocusSession(authB, { sessionId: sessionB.id, expectedVersion: 1 });
    expect((await queries.listFocusHistory(authB)).length).toBe(1);
    expect(await queries.listFocusHistory(authA)).toEqual([]);
  });
});
