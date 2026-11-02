import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { captures } from "@/domains/capture/schema";
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
    await expect(commands.pauseFocusSession(auth, { sessionId: session.id, expectedVersion: 9 })).rejects.toThrow(
      commands.StaleWriteError,
    );
    // A finish from the correct version works...
    await commands.finishFocusSession(auth, { sessionId: session.id, expectedVersion: 1 });
    // ...and a second finish matches no running/paused row: no duplicate, no resurrection.
    await expect(commands.finishFocusSession(auth, { sessionId: session.id, expectedVersion: 2 })).rejects.toThrow(
      commands.StaleWriteError,
    );
  });

  it("rejects the transitions the state matrix forbids", async () => {
    const { userId, workspaceId } = await seedWorkspace(db, `focus-matrix-${Date.now()}`);
    const auth = ownerAuth(userId, workspaceId);

    // running x resume: resume is only legal from paused.
    const running = await commands.startFocusSession(auth, { subject: "Running" });
    await expect(commands.resumeFocusSession(auth, { sessionId: running.id, expectedVersion: 1 })).rejects.toThrow(
      commands.StaleWriteError,
    );
    await commands.abandonFocusSession(auth, { sessionId: running.id, expectedVersion: 1 });

    // paused x pause: no double pause entry.
    const session = await commands.startFocusSession(auth, { subject: "Pausing twice" });
    await commands.pauseFocusSession(auth, { sessionId: session.id, expectedVersion: 1 });
    await expect(commands.pauseFocusSession(auth, { sessionId: session.id, expectedVersion: 2 })).rejects.toThrow(
      commands.StaleWriteError,
    );
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

/** A capture the theatre can schedule from (ASH-308). */
async function seedCapture(workspaceId: string, userId: string, title: string) {
  const [capture] = await db
    .insert(captures)
    .values({
      workspaceId,
      kind: "text",
      captureMode: "authored",
      rawPayload: { text: title },
      text: title,
      title,
      createdBy: userId,
      updatedBy: userId,
    })
    .returning();
  return capture;
}

suite("planned sessions (ASH-308)", () => {
  it("a planned row cannot pause, resume, finish, or abandon through the lifecycle commands", async () => {
    const { userId, workspaceId } = await seedWorkspace(db, `focus-planned-guards-${Date.now()}`);
    const auth = ownerAuth(userId, workspaceId);
    const capture = await seedCapture(workspaceId, userId, "Read the renewal");

    const { sessionId } = await commands.scheduleSessionFromCapture(auth, {
      captureId: capture.id,
      scheduledAt: new Date(Date.now() + 3600_000),
    });
    const [row] = await db.select().from(focusSessions).where(eq(focusSessions.id, sessionId));
    expect(row.startedAt).toBeNull();
    expect(row.scheduledAt).not.toBeNull();

    // The borrowed 'paused' state must not admit the row into any lifecycle
    // transition: each is a stale-write rejection, not a moved clock.
    for (const transition of [
      () => commands.pauseFocusSession(auth, { sessionId, expectedVersion: row.version }),
      () => commands.resumeFocusSession(auth, { sessionId, expectedVersion: row.version }),
      () => commands.finishFocusSession(auth, { sessionId, expectedVersion: row.version }),
      () => commands.abandonFocusSession(auth, { sessionId, expectedVersion: row.version }),
      () => commands.requestAbandonFocusSession(auth, { sessionId, expectedVersion: row.version }),
      () => commands.confirmAbandonFocusSession(auth, { sessionId, expectedVersion: row.version }),
    ]) {
      await expect(transition()).rejects.toThrowError(/changed since you loaded/);
    }
    const [untouched] = await db.select().from(focusSessions).where(eq(focusSessions.id, sessionId));
    expect(untouched.startedAt).toBeNull();
    expect(untouched.state).toBe("paused");
    expect(untouched.version).toBe(row.version);
  });

  it("a planned row never blocks the one live session", async () => {
    const { userId, workspaceId } = await seedWorkspace(db, `focus-planned-live-${Date.now()}`);
    const auth = ownerAuth(userId, workspaceId);
    const capture = await seedCapture(workspaceId, userId, "Inbox zero");
    await commands.scheduleSessionFromCapture(auth, {
      captureId: capture.id,
      scheduledAt: new Date(Date.now() + 3600_000),
    });

    // Live means started: a planned row does not occupy the slot.
    const session = await commands.startFocusSession(auth, { subject: "Real work" });
    expect(session.state).toBe("running");
    const active = await queries.getActiveFocusSession(auth);
    expect(active?.id).toBe(session.id);
  });

  it("a planned row starts only through the scheduled path, with version protection", async () => {
    const { userId, workspaceId } = await seedWorkspace(db, `focus-planned-start-${Date.now()}`);
    const auth = ownerAuth(userId, workspaceId);
    const capture = await seedCapture(workspaceId, userId, "Call the accountant");
    const { sessionId } = await commands.scheduleSessionFromCapture(auth, {
      captureId: capture.id,
      scheduledAt: new Date(Date.now() + 3600_000),
    });
    const [row] = await db.select().from(focusSessions).where(eq(focusSessions.id, sessionId));

    // A stale version is rejected; the row stays planned.
    await expect(
      commands.startScheduledFocusSession(auth, { sessionId, expectedVersion: row.version + 1 }),
    ).rejects.toThrowError(/changed since you loaded/);

    const started = await commands.startScheduledFocusSession(auth, { sessionId, expectedVersion: row.version });
    expect(started.state).toBe("running");
    expect(started.startedAt).not.toBeNull();
    // It is now the one live session - and it occupies the slot, so a rival
    // start conflicts.
    const active = await queries.getActiveFocusSession(auth);
    expect(active?.id).toBe(sessionId);
    await expect(commands.startFocusSession(auth, { subject: "Rival" })).rejects.toThrowError(/already running/);

    // The lifecycle opens up only after the start: pause now works.
    const paused = await commands.pauseFocusSession(auth, { sessionId, expectedVersion: started.version });
    expect(paused.state).toBe("paused");
    expect(paused.startedAt).not.toBeNull();
  });

  it("a double drop replays the first session instead of creating a second", async () => {
    const { userId, workspaceId } = await seedWorkspace(db, `focus-planned-idem-${Date.now()}`);
    const auth = ownerAuth(userId, workspaceId);
    const capture = await seedCapture(workspaceId, userId, "Sort the receipts");
    const slot = new Date(Date.now() + 3600_000);

    const first = await commands.scheduleSessionFromCapture(auth, {
      captureId: capture.id,
      scheduledAt: slot,
      idempotencyKey: "drop-1",
    });
    const second = await commands.scheduleSessionFromCapture(auth, {
      captureId: capture.id,
      scheduledAt: slot,
      idempotencyKey: "drop-1",
    });
    expect(second.sessionId).toBe(first.sessionId);
    expect(second.replayed).toBe(true);
    const rows = await db.select().from(focusSessions).where(eq(focusSessions.workspaceId, workspaceId));
    expect(rows).toHaveLength(1);
  });

  it("the day projection sees planned, running, and live sessions and nothing from another workspace", async () => {
    const { userId, workspaceId } = await seedWorkspace(db, `focus-planned-day-${Date.now()}`);
    const auth = ownerAuth(userId, workspaceId);
    const capture = await seedCapture(workspaceId, userId, "Read the contract");
    const todaySlot = new Date();
    todaySlot.setHours(todaySlot.getHours() + 2);
    const { sessionId } = await commands.scheduleSessionFromCapture(auth, {
      captureId: capture.id,
      scheduledAt: todaySlot,
    });
    const running = await commands.startFocusSession(auth, { subject: "Now" });

    const from = new Date();
    from.setHours(0, 0, 0, 0);
    const to = new Date(from.getTime() + 24 * 3600_000);
    const day = await queries.listDayFocusSessions(auth, { from, to });
    const ids = day.map((session) => session.id);
    expect(ids).toContain(sessionId);
    expect(ids).toContain(running.id);

    const other = await seedWorkspace(db, `focus-planned-other-${Date.now()}`);
    const otherAuth = ownerAuth(other.userId, other.workspaceId);
    const otherDay = await queries.listDayFocusSessions(otherAuth, { from, to });
    expect(otherDay).toHaveLength(0);
  });
});

/*
 * Spec §1 strictness matrix. Every cooldown and cap runs on the server clock:
 * no command takes a timestamp, so the suite moves the stored anchors (the
 * same trick as `backdate` above) instead of waiting out real seconds.
 */
suite("strictness tiers (spec §1)", () => {
  /** Move a pending abandon request into the past, as if the cooldown had run. */
  async function backdateAbandonRequest(sessionId: string, secondsAgo: number) {
    await db
      .update(focusSessions)
      .set({ abandonRequestedAt: new Date(Date.now() - secondsAgo * 1000) })
      .where(eq(focusSessions.id, sessionId));
  }

  /** Move the live pause's log anchor into the past, as if the break had lasted that long. */
  async function backdatePause(sessionId: string, secondsAgo: number) {
    await db
      .update(focusSessions)
      .set({ interruptions: [{ at: new Date(Date.now() - secondsAgo * 1000).toISOString(), reason: "paused" }] })
      .where(eq(focusSessions.id, sessionId));
  }

  it("deep focus does not pause", async () => {
    const { userId, workspaceId } = await seedWorkspace(db, `focus-deep-pause-${Date.now()}`);
    const auth = ownerAuth(userId, workspaceId);

    const session = await commands.startFocusSession(auth, { subject: "Deep", plannedMinutes: 25, strictness: "deep" });
    await expect(
      commands.pauseFocusSession(auth, { sessionId: session.id, expectedVersion: session.version }),
    ).rejects.toThrow(commands.ConflictError);

    const [row] = await db.select().from(focusSessions).where(eq(focusSessions.id, session.id));
    expect(row.state).toBe("running");
    expect(row.version).toBe(session.version); // A refused transition wrote nothing.
  });

  it("deep focus finishes only at its planned time", async () => {
    const { userId, workspaceId } = await seedWorkspace(db, `focus-deep-finish-${Date.now()}`);
    const auth = ownerAuth(userId, workspaceId);

    const session = await commands.startFocusSession(auth, { subject: "Deep", plannedMinutes: 25, strictness: "deep" });
    // Stopping at ~zero elapsed is quitting, not finishing: refused, with the row untouched.
    await expect(
      commands.finishFocusSession(auth, { sessionId: session.id, expectedVersion: session.version }),
    ).rejects.toThrow(commands.ConflictError);

    await backdate(session.id, 25 * 60 + 5);
    const finished = await commands.finishFocusSession(auth, {
      sessionId: session.id,
      expectedVersion: session.version,
    });
    expect(finished.state).toBe("finished");
    expect(finished.accumulatedSeconds).toBeGreaterThanOrEqual(25 * 60);
  });

  it("deep focus cools down 60 seconds before an abandon confirms", async () => {
    const { userId, workspaceId } = await seedWorkspace(db, `focus-deep-abandon-${Date.now()}`);
    const auth = ownerAuth(userId, workspaceId);

    const session = await commands.startFocusSession(auth, { subject: "Deep", plannedMinutes: 25, strictness: "deep" });
    // Confirming before any request is a bug in the caller, not an impulse.
    await expect(
      commands.confirmAbandonFocusSession(auth, { sessionId: session.id, expectedVersion: session.version }),
    ).rejects.toThrowError(/Request the abandon/);

    await commands.requestAbandonFocusSession(auth, { sessionId: session.id, expectedVersion: session.version });
    // Inside the cooldown: refused, and the refusal says what is left.
    await expect(
      commands.confirmAbandonFocusSession(auth, { sessionId: session.id, expectedVersion: session.version + 1 }),
    ).rejects.toThrowError(/cools down for \d+s more/);
    // The refused confirm wrote nothing, so the same version still confirms once the window has passed.
    await backdateAbandonRequest(session.id, 61);
    const abandoned = await commands.confirmAbandonFocusSession(auth, {
      sessionId: session.id,
      expectedVersion: session.version + 1,
    });
    expect(abandoned.state).toBe("abandoned");
    expect(abandoned.endedAt).not.toBeNull();
  });

  it("timeout focus allows two pauses and rejects the third", async () => {
    const { userId, workspaceId } = await seedWorkspace(db, `focus-timeout-caps-${Date.now()}`);
    const auth = ownerAuth(userId, workspaceId);

    const session = await commands.startFocusSession(auth, { subject: "Timeout", strictness: "timeout" });
    await commands.pauseFocusSession(auth, { sessionId: session.id, expectedVersion: 1 });
    await commands.resumeFocusSession(auth, { sessionId: session.id, expectedVersion: 2 });
    await commands.pauseFocusSession(auth, { sessionId: session.id, expectedVersion: 3 });
    await commands.resumeFocusSession(auth, { sessionId: session.id, expectedVersion: 4 });

    await expect(commands.pauseFocusSession(auth, { sessionId: session.id, expectedVersion: 5 })).rejects.toThrowError(
      /two pauses/,
    );

    const [row] = await db.select().from(focusSessions).where(eq(focusSessions.id, session.id));
    expect(row.state).toBe("running");
    expect(row.pauseCount).toBe(2);
    expect(row.version).toBe(5); // Resumes never count as pauses.
  });

  it("a timeout break past five minutes is ended by the server at the cap", async () => {
    const { userId, workspaceId } = await seedWorkspace(db, `focus-timeout-cap-${Date.now()}`);
    const auth = ownerAuth(userId, workspaceId);

    const session = await commands.startFocusSession(auth, { subject: "Timeout", strictness: "timeout" });
    const paused = await commands.pauseFocusSession(auth, { sessionId: session.id, expectedVersion: 1 });
    const banked = paused.accumulatedSeconds;

    // The click lands six minutes later; the server resumes the clock at the
    // five-minute cap, so the extra minute is focus, not break.
    await backdatePause(session.id, 6 * 60);
    const resumed = await commands.resumeFocusSession(auth, { sessionId: session.id, expectedVersion: 2 });
    expect(resumed.state).toBe("running");
    const cap = new Date(Date.now() - 60 * 1000).getTime(); // pauseAt (6 min ago) + the 5-minute cap
    expect(Math.abs(resumed.lastResumedAt!.getTime() - cap)).toBeLessThan(3000);
    expect(resumed.accumulatedSeconds).toBe(banked); // Paused time banks nothing, at any length.
    const log = resumed.interruptions as Array<{ at: string; reason: string }>;
    expect(log[log.length - 1].reason).toBe("auto-resumed");

    // The read projection agrees: elapsed keeps running from the cap.
    const active = await queries.getActiveFocusSession(auth);
    expect(active?.elapsedSeconds).toBeGreaterThanOrEqual(55);
    expect(active?.elapsedSeconds).toBeLessThan(70);
  });

  it("a timeout break within five minutes resumes normally at the click", async () => {
    const { userId, workspaceId } = await seedWorkspace(db, `focus-timeout-within-${Date.now()}`);
    const auth = ownerAuth(userId, workspaceId);

    const session = await commands.startFocusSession(auth, { subject: "Timeout", strictness: "timeout" });
    await commands.pauseFocusSession(auth, { sessionId: session.id, expectedVersion: 1 });
    await backdatePause(session.id, 4 * 60); // Still inside the cap.

    const resumed = await commands.resumeFocusSession(auth, { sessionId: session.id, expectedVersion: 2 });
    expect(resumed.state).toBe("running");
    // The break did not expire: the clock resumes at the click, not at the cap.
    expect(Math.abs(resumed.lastResumedAt!.getTime() - Date.now())).toBeLessThan(3000);
    const log = resumed.interruptions as Array<{ at: string; reason: string }>;
    expect(log[log.length - 1].reason).toBe("resumed");
  });

  it("timeout focus cools down 30 seconds before an abandon confirms", async () => {
    const { userId, workspaceId } = await seedWorkspace(db, `focus-timeout-abandon-${Date.now()}`);
    const auth = ownerAuth(userId, workspaceId);

    const session = await commands.startFocusSession(auth, { subject: "Timeout", strictness: "timeout" });
    await commands.requestAbandonFocusSession(auth, { sessionId: session.id, expectedVersion: session.version });
    await expect(
      commands.confirmAbandonFocusSession(auth, { sessionId: session.id, expectedVersion: session.version + 1 }),
    ).rejects.toThrowError(/cools down for \d+s more/);

    await backdateAbandonRequest(session.id, 31);
    const abandoned = await commands.confirmAbandonFocusSession(auth, {
      sessionId: session.id,
      expectedVersion: session.version + 1,
    });
    expect(abandoned.state).toBe("abandoned");
  });

  it("normal focus requests and confirms an abandon in one breath, and a start rejects an unknown tier", async () => {
    const { userId, workspaceId } = await seedWorkspace(db, `focus-normal-abandon-${Date.now()}`);
    const auth = ownerAuth(userId, workspaceId);

    const session = await commands.startFocusSession(auth, { subject: "Normal" });
    expect(session.strictness).toBe("normal"); // The default tier behaves as always.
    await commands.requestAbandonFocusSession(auth, { sessionId: session.id, expectedVersion: session.version });
    const abandoned = await commands.confirmAbandonFocusSession(auth, {
      sessionId: session.id,
      expectedVersion: session.version + 1,
    });
    expect(abandoned.state).toBe("abandoned");

    await expect(
      commands.startFocusSession(auth, { subject: "Junk", strictness: "extreme" as never }),
    ).rejects.toThrowError(/tier does not exist/);
  });

  it("resuming dissolves a pending abandon request", async () => {
    const { userId, workspaceId } = await seedWorkspace(db, `focus-abandon-clear-${Date.now()}`);
    const auth = ownerAuth(userId, workspaceId);

    const session = await commands.startFocusSession(auth, { subject: "Second thoughts" });
    await commands.pauseFocusSession(auth, { sessionId: session.id, expectedVersion: 1 });
    await commands.requestAbandonFocusSession(auth, { sessionId: session.id, expectedVersion: 2 });
    await commands.resumeFocusSession(auth, { sessionId: session.id, expectedVersion: 3 });

    const [row] = await db.select().from(focusSessions).where(eq(focusSessions.id, session.id));
    expect(row.abandonRequestedAt).toBeNull(); // Back to work means the request is gone.
    await expect(
      commands.confirmAbandonFocusSession(auth, { sessionId: session.id, expectedVersion: row.version }),
    ).rejects.toThrowError(/Request the abandon/);
  });
});
