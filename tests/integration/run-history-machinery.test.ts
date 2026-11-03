import { drizzle } from "drizzle-orm/postgres-js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agentProfiles, agentRuns } from "@/domains/agents/schema";
import { makeTestDb, seedWorkspace } from "../helpers/test-workspace";

/*
 * The history surfaces (the home page's conversations, the run page's
 * sidebar, GET /api/v1/runs, the triage feed) all read listRecentRuns, and
 * every conversation there must be one a person typed. The assessor's judge
 * run leaked: its objective is the judge brief ("You are judging one
 * candidate for admission…") — machine prose listed as a chat the person
 * never had. The fix excludes runs whose subjects carry the machinery
 * namespace (`superagent_*`) from the query itself; this pins that the
 * exclusion reads the row's subjects rather than its words, covers every
 * machinery run kind, and leaves person-initiated subject-bearing runs
 * (a project run, say) visible.
 */

const handle = makeTestDb();
const suite = handle ? describe : describe.skip;
const holder: { db: ReturnType<typeof drizzle> | undefined } = { db: undefined };
vi.mock("@/lib/db", () => ({
  get db() {
    return holder.db;
  },
}));

import { listRecentRuns } from "@/domains/agents/queries";

let ws: { userId: string; workspaceId: string };
let profileId: string;

beforeAll(async () => {
  holder.db = handle?.db;
  ws = await seedWorkspace(handle!.db, "hist-mach");
  const [profile] = await handle!.db
    .insert(agentProfiles)
    .values({ workspaceId: ws.workspaceId, name: "polymath" })
    .returning({ id: agentProfiles.id });
  profileId = profile.id;
});

afterAll(async () => {
  await handle?.client.end();
});

function insertRun(objective: string, subjects: unknown) {
  return handle!.db
    .insert(agentRuns)
    .values({
      workspaceId: ws.workspaceId,
      agentProfileId: profileId,
      objective,
      subjects: subjects as never,
      policySnapshot: {},
    })
    .returning({ id: agentRuns.id });
}

suite("listRecentRuns hides machinery runs", () => {
  it("lists only runs a person typed, whatever their subjects", async () => {
    const [conversation] = await insertRun("Plan the week around the two reviews", []);
    const [projectRun] = await insertRun("Summarize the launch project's open threads", [
      { type: "project", id: crypto.randomUUID() },
    ]);
    await insertRun("You are judging one candidate for admission to the workspace.", [
      { type: "superagent_assessment", id: crypto.randomUUID() },
    ]);
    await insertRun("Work the accepted ticket to done.", [
      { type: "superagent_ticket", id: crypto.randomUUID() },
      { type: "superagent_ticket_run", id: crypto.randomUUID() },
    ]);

    // Set membership, not order: same-millisecond rows have no tiebreaker on
    // createdAt, and this test claims visibility, not ordering.
    for (const options of [{ excludeOnboarding: true }, {}]) {
      const runs = await listRecentRuns(ws.workspaceId, 50, options);
      expect(new Set(runs.map((run) => run.id))).toEqual(new Set([conversation.id, projectRun.id]));
    }
  });
});
