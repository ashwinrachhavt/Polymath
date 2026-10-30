import { drizzle } from "drizzle-orm/postgres-js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { onboardingSessions } from "@/domains/agents/schema";
import { makeTestDb, ownerAuth, seedWorkspace } from "../helpers/test-workspace";

/*
 * The consumer contract behind the settings brief surface (spec "It learns
 * your taste"): a changed brief reaches the NEXT run's driver.start, an
 * already-running run is never re-fed (it keeps the brief it started with),
 * and a retired brief passes null - the onboarding session's retained
 * original is provenance, never a fallback.
 */

const handle = makeTestDb();
const suite = handle ? describe : describe.skip;
const holder: { db: ReturnType<typeof drizzle> | undefined } = { db: undefined };
vi.mock("@/lib/db", () => ({ get db() { return holder.db; } }));
vi.mock("@/lib/db-transaction", () => ({
  get withTransaction() {
    return (fn: Parameters<typeof import("@/lib/db-transaction").withTransaction>[0]) =>
      (holder.db!.transaction as typeof import("@/lib/db-transaction").withTransaction)(fn);
  },
}));

let engineModule: typeof import("@/domains/agents/engine");
let commands: typeof import("@/domains/agents/commands");

beforeAll(async () => {
  if (!handle) return;
  holder.db = handle.db;
  engineModule = await import("@/domains/agents/engine");
  commands = await import("@/domains/agents/commands");
});
afterAll(async () => { await handle?.client.end(); });

type StartCall = { sessionId: string; instructions: string | null };
function capturingDriver(calls: { starts: StartCall[]; signals: string[] }) {
  return {
    start: async (input: StartCall & { auth: unknown; policy: unknown; objective: string }) => {
      calls.starts.push({ sessionId: input.sessionId, instructions: input.instructions });
    },
    signal: async (sessionId: string, signal: string) => { calls.signals.push(`${sessionId}:${signal}`); },
    cancel: async () => {},
  };
}

suite("run brief consumption (real Postgres)", () => {
  it("future runs get the edited brief, running work keeps its own, retirement never falls back to onboarding", async () => {
    const seeded = await seedWorkspace(holder.db!, `brief-run-${Date.now()}`);
    const auth = ownerAuth(seeded.userId, seeded.workspaceId);
    await commands.ensureProfile(seeded.workspaceId);
    const profile = (await import("@/domains/agents/queries")).getDefaultProfile;
    const v0 = (await profile(auth))!;

    // The onboarding session retains the verbatim original as provenance.
    await holder.db!.insert(onboardingSessions).values({
      workspaceId: seeded.workspaceId, userId: seeded.userId, status: "completed",
      personifiedBrief: "ORIGINAL ONBOARDING BRIEF - provenance only",
    });

    // Brief v1 is consumed at run start.
    await commands.updateDefaultProfileBrief(auth, { description: "d1", instructions: "Brief alpha.", expectedVersion: v0.version });
    const calls = { starts: [] as StartCall[], signals: [] as string[] };
    const engine = engineModule.createEngine(capturingDriver(calls));
    const run1 = await engine.start({ auth, profileName: "polymath", objective: "First", subjects: [], estimateUsd: "0.0001" });
    expect(calls.starts[0]).toMatchObject({ instructions: "Brief alpha." });

    // Editing the brief changes what the NEXT run gets...
    const v1 = (await profile(auth))!;
    await commands.updateDefaultProfileBrief(auth, { description: "d1", instructions: "Brief beta.", expectedVersion: v1.version });
    await engine.start({ auth, profileName: "polymath", objective: "Second", subjects: [], estimateUsd: "0.0001" });
    expect(calls.starts[1]).toMatchObject({ instructions: "Brief beta." });

    // ...while the already-running first run is never re-fed: a signal
    // reaches the same session and no fresh start (no fresh brief) occurs.
    await engine.signal(run1.runId, "keep going", auth);
    expect(calls.signals).toEqual([`${run1.runId}:keep going`]);
    expect(calls.starts.filter((s) => s.sessionId === run1.runId)).toHaveLength(1);

    // Retiring passes null - NOT the onboarding original, NOT the last value.
    const v2 = (await profile(auth))!;
    const retired = await commands.updateDefaultProfileBrief(auth, { description: "", instructions: "", expectedVersion: v2.version });
    expect(retired).toMatchObject({ ok: true, profile: { description: null, instructions: null } });
    const run3 = await engine.start({ auth, profileName: "polymath", objective: "Third", subjects: [], estimateUsd: "0.0001" });
    expect(calls.starts[2]).toMatchObject({ sessionId: run3.runId, instructions: null });
  });
});
