import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agentProfiles, agentRuns } from "@/domains/agents/schema";
import { artifactVersions, artifacts } from "@/domains/knowledge/schema";
import { tasks } from "@/domains/work/schema";
import { makeTestDb, seedWorkspace } from "../helpers/test-workspace";

const handle = makeTestDb();
const suite = handle ? describe : describe.skip;
const holder: { db: ReturnType<typeof drizzle> | undefined } = { db: undefined };
vi.mock("@/lib/db", () => ({ get db() { return holder.db; } }));
import { getRunBySessionRef } from "@/domains/agents/queries";
import { listOpenTasks } from "@/domains/work/queries";

beforeAll(() => { holder.db = handle?.db; });
afterAll(async () => { await handle?.client.end(); });

/**
 * A task is a note plus its extension row, and every task read joins the note.
 * Fixtures insert the note by hand so this suite keeps exercising real Postgres
 * rows rather than the production writer.
 */
async function insertTask(
  db: NonNullable<typeof holder.db>,
  row: {
    workspaceId: string;
    title: string;
    status?: (typeof tasks.$inferSelect)["status"];
    rank?: string;
    archivedAt?: Date;
  },
) {
  const [note] = await db
    .insert(artifacts)
    .values({ workspaceId: row.workspaceId, kind: "note", title: row.title, template: "issue" })
    .returning({ id: artifacts.id });
  const [version] = await db
    .insert(artifactVersions)
    .values({ workspaceId: row.workspaceId, artifactId: note.id, versionNumber: 1, content: { type: "doc", content: [] }, reason: "created" })
    .returning({ id: artifactVersions.id });
  await db.update(artifacts).set({ currentVersionId: version.id }).where(eq(artifacts.id, note.id));
  const [task] = await db
    .insert(tasks)
    .values({
      workspaceId: row.workspaceId,
      noteId: note.id,
      title: row.title,
      ...(row.status ? { status: row.status } : {}),
      ...(row.rank ? { rank: row.rank } : {}),
      ...(row.archivedAt ? { archivedAt: row.archivedAt } : {}),
    })
    .returning({ id: tasks.id });
  return task;
}

async function seedRun() {
  const db = holder.db!;
  const auth = await seedWorkspace(db, `session-${crypto.randomUUID()}`);
  const [profile] = await db.insert(agentProfiles).values({ workspaceId: auth.workspaceId, name: "alfred" }).returning();
  const policySnapshot = { allowedTools: ["tasks.read"], allowedAccounts: [], budgetUsd: { perRunCeilingUsd: "0.50" }, auth };
  const sessionRef = `wrun_${crypto.randomUUID()}`;
  const [run] = await db.insert(agentRuns).values({
    workspaceId: auth.workspaceId, agentProfileId: profile.id, objective: "Fixture", state: "running", sessionRef, policySnapshot,
  }).returning();
  return { auth, profile, run, sessionRef, policySnapshot };
}

suite("persisted Eve session binding and task reads (real Postgres)", () => {
  it("resolves a wrun text ID to the run UUID and its original frozen policy", async () => {
    const { run, auth, sessionRef, policySnapshot } = await seedRun();
    expect(await getRunBySessionRef(sessionRef, auth.workspaceId)).toEqual({ id: run.id, state: "running", policySnapshot, subjects: [] });
  });

  it("does not guess a run from a foreign workspace or treat a run UUID as a session reference", async () => {
    const { run, auth, sessionRef } = await seedRun();
    expect(await getRunBySessionRef(sessionRef, crypto.randomUUID())).toBeNull();
    expect(await getRunBySessionRef(run.id, auth.workspaceId)).toBeNull();
    expect(await getRunBySessionRef("wrun_unknown", auth.workspaceId)).toBeNull();
  });

  it("ambiguous legacy bindings fail closed rather than picking an arbitrary policy/budget", async () => {
    const { run, auth, sessionRef, profile } = await seedRun();
    await holder.db!.insert(agentRuns).values({
      workspaceId: auth.workspaceId, agentProfileId: profile.id, objective: "Different run", state: "running", sessionRef,
      policySnapshot: { allowedTools: ["gmail.send"] },
    });
    expect(await getRunBySessionRef(sessionRef, auth.workspaceId)).toBeNull();
    expect(run.id).not.toBe(sessionRef);
  });

  it("returns bounded canonical open tasks without foreign, archived, done, or cancelled rows", async () => {
    const { auth } = await seedRun();
    const other = await seedWorkspace(holder.db!, `other-tasks-${crypto.randomUUID()}`);
    const make = (row: { title: string; status?: (typeof tasks.$inferSelect)["status"]; rank: string; archivedAt?: Date }, workspaceId: string) =>
      insertTask(holder.db!, { workspaceId, ...row });
    await make({ title: "First open", status: "ready", rank: "a" }, auth.workspaceId);
    await make({ title: "Second open", status: "waiting", rank: "b" }, auth.workspaceId);
    await make({ title: "Done", status: "done", rank: "a" }, auth.workspaceId);
    await make({ title: "Cancelled", status: "cancelled", rank: "a" }, auth.workspaceId);
    await make({ title: "Archived", status: "ready", archivedAt: new Date(), rank: "a" }, auth.workspaceId);
    await make({ title: "Foreign private task", status: "ready", rank: "a" }, other.workspaceId);
    const visible = await listOpenTasks(auth);
    expect(visible.map((task) => task.title)).toEqual(["First open", "Second open"]);
    expect((await listOpenTasks(auth, 1)).map((task) => task.title)).toEqual(["First open"]);
    await expect(listOpenTasks(auth, 51)).rejects.toThrow("Invalid task limit");
  });
});
