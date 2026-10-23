import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agentProfiles, agentRuns, runEvents } from "@/domains/agents/schema";
import { makeTestDb, seedWorkspace } from "../helpers/test-workspace";

/*
 * getRunUsage: a run's cost is summed from its usage events as numeric in
 * SQL, tenant-scoped, and null (unknown) when nothing was recorded - never a
 * fabricated zero. Runs and events are seeded directly; the sum itself is
 * what is under test.
 */

const handle = makeTestDb();
const suite = handle ? describe : describe.skip;
let queries: typeof import("@/domains/agents/queries");

beforeAll(async () => {
  if (!handle) return;
  queries = await import("@/domains/agents/queries");
});

afterAll(async () => {
  await handle?.client.end();
});

async function seedRun(slug: string) {
  const { userId, workspaceId } = await seedWorkspace(handle!.db, `${slug}-${Date.now()}`);
  const [profile] = await handle!.db.insert(agentProfiles).values({ workspaceId, name: "alfred" }).returning();
  const [run] = await handle!.db
    .insert(agentRuns)
    .values({ workspaceId, agentProfileId: profile.id, objective: "Summarise the week", policySnapshot: {}, createdBy: userId, updatedBy: userId })
    .returning();
  return { userId, workspaceId, run };
}

async function addUsage(
  runId: string,
  workspaceId: string,
  sequence: number,
  costUsd: string | null,
  inputTokens: number,
  outputTokens: number,
) {
  await handle!.db.insert(runEvents).values({
    workspaceId,
    runId,
    sequence,
    type: "usage",
    data: costUsd === null ? { inputTokens, outputTokens } : { costUsd, inputTokens, outputTokens },
  });
}

suite("getRunUsage", () => {
  it("sums usage events as numeric, tokens as integers", async () => {
    const { workspaceId, run } = await seedRun("run-usage-sum");
    await addUsage(run.id, workspaceId, 1, "0.0015", 1200, 300);
    await addUsage(run.id, workspaceId, 2, "0.0025", 800, 200);

    const usage = await queries.getRunUsage(workspaceId, run.id);
    expect(usage).not.toBeNull();
    expect(Number(usage!.usd)).toBeCloseTo(0.004, 6);
    expect(usage!.inputTokens).toBe(2000);
    expect(usage!.outputTokens).toBe(500);
  });

  it("is null - unknown, not zero - when the run recorded no usage", async () => {
    const { workspaceId, run } = await seedRun("run-usage-none");
    expect(await queries.getRunUsage(workspaceId, run.id)).toBeNull();
  });

  it("reports cost as unknown - never $0 - when usage events carry no price", async () => {
    const { workspaceId, run } = await seedRun("run-usage-unpriced");
    await addUsage(run.id, workspaceId, 1, null, 1200, 300);

    const usage = await queries.getRunUsage(workspaceId, run.id);
    expect(usage).not.toBeNull();
    expect(usage!.usd).toBeNull();
    expect(usage!.pricedEvents).toBe(0);
    expect(usage!.usageEvents).toBe(1);
    expect(usage!.inputTokens).toBe(1200);
  });

  it("sums only the priced events when priced and unpriced usage mix", async () => {
    const { workspaceId, run } = await seedRun("run-usage-mixed");
    await addUsage(run.id, workspaceId, 1, "0.0015", 1200, 300);
    await addUsage(run.id, workspaceId, 2, null, 800, 200);

    const usage = await queries.getRunUsage(workspaceId, run.id);
    expect(usage).not.toBeNull();
    expect(Number(usage!.usd)).toBeCloseTo(0.0015, 6);
    expect(usage!.pricedEvents).toBe(1);
    expect(usage!.usageEvents).toBe(2);
    expect(usage!.inputTokens).toBe(2000);
  });

  it("never reads another workspace's events", async () => {
    const mine = await seedRun("run-usage-mine");
    const theirs = await seedRun("run-usage-theirs");
    await addUsage(theirs.run.id, theirs.workspaceId, 1, "9.99", 1, 1);

    expect(await queries.getRunUsage(mine.workspaceId, mine.run.id)).toBeNull();
    expect(await queries.getRunUsage(mine.workspaceId, theirs.run.id)).toBeNull();
  });
});
