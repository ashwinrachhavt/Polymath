import { and, eq, isNull, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agentProfiles, agentRuns, onboardingSessions } from "@/domains/agents/schema";
import { makeTestDb, ownerAuth, seedWorkspace } from "../helpers/test-workspace";

/*
 * ASH-296 against real Postgres: the interview is a durable engine run with
 * no tools and a dime of budget; starting is resume-first; the confirm click
 * is the only path that stamps onboarded_at; the brief is read back from
 * persisted run events; a run from another workspace is invisible.
 *
 * Import discipline: onboarding.ts reaches @/lib/db through the engine, so it
 * lazy-imports after makeTestDb has pointed DATABASE_URL at the scratch
 * database. A fake SessionDriver stands in for Eve - these tests prove the
 * run/session/spend semantics, not the bridge.
 */

const handle = makeTestDb();
const suite = handle ? describe : describe.skip;
let db: NonNullable<typeof handle>["db"];
let onboarding: typeof import("@/domains/agents/onboarding");
let eventBridge: typeof import("@/domains/agents/event-bridge");

beforeAll(async () => {
  if (!handle) return;
  ({ db } = handle);
  onboarding = await import("@/domains/agents/onboarding");
  eventBridge = await import("@/domains/agents/event-bridge");
});

afterAll(async () => {
  await handle?.client.end();
});

function fakeDriver(starts: string[]) {
  return {
    async start(input: { sessionId: string }) {
      starts.push(input.sessionId);
      // The eve driver writes session_ref after create; mirror that so the
      // run row looks the way a live interview's does.
      await db
        .update(agentRuns)
        .set({ sessionRef: `wrun_test_${starts.length}` })
        .where(eq(agentRuns.id, input.sessionId));
    },
    async signal() {},
    async cancel() {},
  };
}

async function onboardedAt(workspaceId: string): Promise<Date | null> {
  const [row] = await db
    .select({ value: sql<Date | null>`(select onboarded_at from workspaces where id = ${workspaceId})` })
    .from(sql`(select 1) as probe`);
  return row?.value ?? null;
}

suite("onboarding interview flow", () => {
  it("startOnboardingRun creates one durable run with no tools and claims the session row", async () => {
    const seeded = await seedWorkspace(db, `onb-start-${Date.now()}`);
    const auth = ownerAuth(seeded.userId, seeded.workspaceId);
    const starts: string[] = [];

    const first = await onboarding.startOnboardingRun(auth, fakeDriver(starts));
    expect(first.resumed).toBe(false);
    expect(starts).toEqual([first.runId]);

    const [run] = await db.select().from(agentRuns).where(eq(agentRuns.id, first.runId)).limit(1);
    expect(run.state).toBe("running");
    expect(run.objective).toBe(onboarding.ONBOARDING_OBJECTIVE);
    expect((run.policySnapshot as { allowedTools?: unknown }).allowedTools).toEqual([]);

    // The session row exists and stays in_progress until the confirm click.
    const [session] = await db
      .select()
      .from(onboardingSessions)
      .where(
        and(
          eq(onboardingSessions.workspaceId, seeded.workspaceId),
          isNull(onboardingSessions.archivedAt),
        ),
      )
      .limit(1);
    expect(session.status).toBe("in_progress");

    // The objective is the thread's first persisted message.
    const reading = await onboarding.readOnboardingRun(auth, first.runId);
    expect(reading?.thread[0]?.kind).toBe("user");
    expect(reading?.thread[0]?.text).toContain("onboarding-interview v1");

    // No path stamps onboarded_at before the confirm click.
    expect(await onboarding.isWorkspaceOnboarded(seeded.workspaceId)).toBe(false);
    expect(await onboardedAt(seeded.workspaceId)).toBeNull();
  });

  it("a second start resumes the open run instead of forking a second one", async () => {
    const seeded = await seedWorkspace(db, `onb-resume-${Date.now()}`);
    const auth = ownerAuth(seeded.userId, seeded.workspaceId);
    const starts: string[] = [];

    const first = await onboarding.startOnboardingRun(auth, fakeDriver(starts));
    const second = await onboarding.startOnboardingRun(auth, fakeDriver(starts));
    expect(second).toEqual({ runId: first.runId, resumed: true });
    expect(starts).toHaveLength(1);

    const runs = await db
      .select({ id: agentRuns.id })
      .from(agentRuns)
      .where(and(eq(agentRuns.workspaceId, seeded.workspaceId), eq(agentRuns.objective, onboarding.ONBOARDING_OBJECTIVE)));
    expect(runs).toHaveLength(1);
  });

  it("readOnboardingRun validates the persisted brief and salvages a malformed one", async () => {
    const seeded = await seedWorkspace(db, `onb-brief-${Date.now()}`);
    const auth = ownerAuth(seeded.userId, seeded.workspaceId);
    const { runId } = await onboarding.startOnboardingRun(auth, fakeDriver([]));

    await eventBridge.recordRoundEvent({
      runId,
      workspaceId: seeded.workspaceId,
      type: "message",
      data: {
        role: "assistant",
        content:
          'You are an engineer in Notion and Gmail, and I am Jarvis.\n\n```onboarding-brief\n{"role":"Software engineer","tools":["Notion","Gmail"],"priorities":["Keep research searchable"],"agentName":"Jarvis"}\n```',
      },
    });

    const reading = await onboarding.readOnboardingRun(auth, runId);
    expect(reading?.brief).toEqual({
      role: "Software engineer",
      tools: ["Notion", "Gmail"],
      priorities: ["Keep research searchable"],
      agentName: "Jarvis",
    });
    expect(reading?.profileVersion).not.toBeNull();

    // A malformed payload never becomes a brief; its fields still pre-fill.
    const second = await seedWorkspace(db, `onb-bad-${Date.now()}`);
    const auth2 = ownerAuth(second.userId, second.workspaceId);
    const { runId: runId2 } = await onboarding.startOnboardingRun(auth2, fakeDriver([]));
    await eventBridge.recordRoundEvent({
      runId: runId2,
      workspaceId: second.workspaceId,
      type: "message",
      data: {
        role: "assistant",
        content: '```onboarding-brief\n{"role":"Designer","agentName":"A"}\n```',
      },
    });
    const bad = await onboarding.readOnboardingRun(auth2, runId2);
    expect(bad?.brief).toBeNull();
    expect(bad?.prefill).toEqual({ role: "Designer", agentName: "A" });
  });

  it("a run from another workspace is invisible to the reader and the finder", async () => {
    const one = await seedWorkspace(db, `onb-ten-a-${Date.now()}`);
    const two = await seedWorkspace(db, `onb-ten-b-${Date.now()}`);
    const { runId } = await onboarding.startOnboardingRun(ownerAuth(one.userId, one.workspaceId), fakeDriver([]));

    expect(await onboarding.readOnboardingRun(ownerAuth(two.userId, two.workspaceId), runId)).toBeNull();
    expect((await onboarding.findLiveOnboardingRun(two.workspaceId))?.id ?? null).toBeNull();
  });

  it("completeOnboarding keeps its contract: brief, session, stamp and audit in one commit", async () => {
    const seeded = await seedWorkspace(db, `onb-commit-${Date.now()}`);
    const auth = ownerAuth(seeded.userId, seeded.workspaceId);
    await onboarding.startOnboardingRun(auth, fakeDriver([]));

    const { brief } = await onboarding.completeOnboarding(auth, {
      agentName: "Jarvis",
      role: "Software engineer",
      tools: ["Notion"],
      priorities: ["Keep research searchable"],
    });
    expect(brief).toContain("Software engineer");

    const [profile] = await db
      .select()
      .from(agentProfiles)
      .where(and(eq(agentProfiles.workspaceId, seeded.workspaceId), eq(agentProfiles.name, "polymath")))
      .limit(1);
    expect(profile.description).toBe(brief);
    expect(profile.instructions).toBe(brief);

    const [session] = await db
      .select()
      .from(onboardingSessions)
      .where(and(eq(onboardingSessions.workspaceId, seeded.workspaceId), isNull(onboardingSessions.archivedAt)))
      .limit(1);
    expect(session.status).toBe("completed");
    expect(session.personifiedBrief).toBe(brief);

    expect(await onboardedAt(seeded.workspaceId)).not.toBeNull();
    expect(await onboarding.isWorkspaceOnboarded(seeded.workspaceId)).toBe(true);

    const audit = await db.execute(
      sql`select action from audit_events where workspace_id = ${seeded.workspaceId} and action = 'onboarding.completed'`,
    );
    expect(audit.length).toBe(1);
  });

  it("the expectedVersion guard rejects a confirm that raced another tab", async () => {
    const seeded = await seedWorkspace(db, `onb-race-${Date.now()}`);
    const auth = ownerAuth(seeded.userId, seeded.workspaceId);
    await onboarding.startOnboardingRun(auth, fakeDriver([]));
    const reading = await onboarding.readOnboardingRun(auth, (await onboarding.findLiveOnboardingRun(seeded.workspaceId))!.id);

    await expect(
      onboarding.completeOnboarding(auth, {
        agentName: "Jarvis",
        role: "Engineer",
        tools: [],
        priorities: [],
        expectedVersion: (reading?.profileVersion ?? 0) + 1,
      }),
    ).rejects.toThrow(/changed in another tab/);
  });
});

/*
 * The full journey at the action layer (ASH-296 acceptance 1-2): start the
 * interview, the agent's final turn lands as a persisted message, the confirm
 * action parses the edited brief and commits - profile brief, session row,
 * onboarded_at, audit - and the gate flips. A fake SessionDriver stands in
 * for Eve and auth is the seeded owner, so no live model runs and no shared
 * workspace marker moves.
 */
suite("onboarding interview journey (action layer)", () => {
  it("interview -> brief -> confirm -> committed and gated", async () => {
    const seeded = await seedWorkspace(db, `onb-journey-${Date.now()}`);
    const auth = ownerAuth(seeded.userId, seeded.workspaceId);
    const starts: string[] = [];

    const { runId } = await onboarding.startOnboardingRun(auth, fakeDriver(starts));

    // The agent's closing turn: summary plus the fenced payload, persisted
    // exactly the way the bridge writes assistant messages.
    await eventBridge.recordRoundEvent({
      runId,
      workspaceId: seeded.workspaceId,
      type: "message",
      data: {
        role: "assistant",
        content:
          'You write software and live in Notion and Gmail; shipping the research library matters most, and I am Jarvis.\n\n```onboarding-brief\n{"role":"Software engineer","tools":["Notion","Gmail"],"priorities":["Ship the research library"],"agentName":"Jarvis"}\n```',
      },
    });

    const reading = await onboarding.readOnboardingRun(auth, runId);
    expect(reading?.brief?.agentName).toBe("Jarvis");

    // The confirm click is what the card sends: the (possibly edited) brief
    // plus the profile version the card rendered at.
    await onboarding.completeOnboarding(auth, {
      ...reading!.brief!,
      expectedVersion: reading!.profileVersion ?? undefined,
    });

    const [profile] = await db
      .select()
      .from(agentProfiles)
      .where(and(eq(agentProfiles.workspaceId, seeded.workspaceId), eq(agentProfiles.name, "polymath")))
      .limit(1);
    expect(profile.description).toContain("Software engineer");
    expect(profile.description).toContain("Notion, Gmail");
    expect(profile.description).toContain("Ship the research library");

    expect(await onboarding.isWorkspaceOnboarded(seeded.workspaceId)).toBe(true);
    expect(await onboardedAt(seeded.workspaceId)).not.toBeNull();

    const [session] = await db
      .select()
      .from(onboardingSessions)
      .where(and(eq(onboardingSessions.workspaceId, seeded.workspaceId), isNull(onboardingSessions.archivedAt)))
      .limit(1);
    expect(session.status).toBe("completed");

    const audit = await db.execute(
      sql`select action, summary from audit_events where workspace_id = ${seeded.workspaceId} and action = 'onboarding.completed'`,
    );
    expect(audit.length).toBe(1);
    expect((audit[0] as { summary: string }).summary).toContain("Jarvis");

    // One interview run, one driver session: the journey never forked.
    expect(starts).toHaveLength(1);
  });
});
