import { eq } from "drizzle-orm";
import type { drizzle } from "drizzle-orm/postgres-js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { makeTestDb, ownerAuth, seedWorkspace } from "../helpers/test-workspace";

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

import { createEngine, type SessionDriver } from "@/domains/agents/engine";
import { agentRuns } from "@/domains/agents/schema";
import { installSpecialist, createCustomSpecialist } from "@/domains/agents/specialists";
import { specialistProfileName } from "@/domains/agents/roster";
import { recordRoundEvent } from "@/domains/agents/event-bridge";

/*
 * The bench invariants, on real Postgres (the unique index and the run's
 * policy freeze are database behaviour; a mock would prove the mock works):
 *   - installing a roster role is idempotent on (workspace, name);
 *   - a custom specialist name collision is a conflict, not a silent reuse;
 *   - hiring freezes the specialist's own instructions and tool scope into the
 *     run's policy snapshot, and the driver receives the brief with the start.
 */

beforeAll(() => { holder.db = handle?.db; });
afterAll(async () => { await handle?.client.end(); });

function fakeDriver(): SessionDriver & { starts: Array<{ objective: string; instructions: string | null }> } {
  const starts: Array<{ objective: string; instructions: string | null }> = [];
  return {
    starts,
    async start(input) {
      starts.push({ objective: input.objective, instructions: input.instructions });
    },
    async signal() {},
    async cancel() {},
  };
}

suite("specialists (integration)", () => {
  it("installs a roster role once; a second install returns the same profile", async () => {
    const { userId, workspaceId } = await seedWorkspace(handle!.db, `spec-${Date.now()}`);
    const auth = ownerAuth(userId, workspaceId);

    const first = await installSpecialist(auth, { slug: "api-tester" });
    const second = await installSpecialist(auth, { slug: "api-tester" });

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.profileId).toBe(first.profileId);
    expect(first.name).toBe(specialistProfileName("api-tester"));
  });

  it("rejects an unknown roster slug", async () => {
    const { userId, workspaceId } = await seedWorkspace(handle!.db, `spec-${Date.now()}-x`);
    await expect(installSpecialist(ownerAuth(userId, workspaceId), { slug: "nope" })).rejects.toThrow(
      /Unknown specialist/,
    );
  });

  it("rejects a duplicate custom specialist name", async () => {
    const { userId, workspaceId } = await seedWorkspace(handle!.db, `spec-${Date.now()}-c`);
    const auth = ownerAuth(userId, workspaceId);
    const input = { name: "Launch Copywriter", mission: "Writes launch copy.", instructions: "You write launch copy.", allowedTools: ["web.search"] };
    await createCustomSpecialist(auth, input);
    await expect(createCustomSpecialist(auth, input)).rejects.toThrow(/already exists/);
  });

  it("hiring freezes the specialist's brief and tool scope into the run", async () => {
    const { userId, workspaceId } = await seedWorkspace(handle!.db, `spec-${Date.now()}-h`);
    const auth = ownerAuth(userId, workspaceId);

    const { name } = await installSpecialist(auth, { slug: "trend-researcher" });
    const driver = fakeDriver();
    const engine = createEngine(driver, () => new Date(), recordRoundEvent);
    const { runId } = await engine.start({
      auth,
      profileName: name,
      objective: "What are teams paying for AI note-takers this quarter?",
      subjects: [],
      estimateUsd: "0.50",
    });

    // The driver got the objective and the role brief, so the eve session can
    // adopt the specialist from its first context message.
    expect(driver.starts).toHaveLength(1);
    expect(driver.starts[0].objective).toContain("note-takers");
    expect(driver.starts[0].instructions).toContain("trend research specialist");

    const [run] = await handle!.db.select().from(agentRuns).where(eq(agentRuns.id, runId)).limit(1);
    expect(run.state).toBe("running");
    const snapshot = run.policySnapshot as { allowedTools?: unknown };
    expect(snapshot.allowedTools).toEqual(["tasks.read", "documents.search", "web.search"]);
  });

  it("refuses to hire a profile that does not exist", async () => {
    const { userId, workspaceId } = await seedWorkspace(handle!.db, `spec-${Date.now()}-m`);
    const engine = createEngine(fakeDriver(), () => new Date(), recordRoundEvent);
    await expect(
      engine.start({
        auth: ownerAuth(userId, workspaceId),
        profileName: specialistProfileName("api-tester"),
        objective: "anything",
        subjects: [],
        estimateUsd: "0.50",
      }),
    ).rejects.toThrow(/Unknown agent profile/);
  });
});
