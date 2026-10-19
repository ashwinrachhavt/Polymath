import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { auditEvents } from "@/domains/audit/schema";
import { makeTestDb, ownerAuth, seedWorkspace } from "../helpers/test-workspace";

/*
 * The pipeline invariants that only real Postgres holds: a stage change and
 * its history row commit together, the recorded from-stage is the stage the
 * update actually beat (races rejected, not merged), terminal stages set the
 * outcome once, and tenancy isolates every read.
 */

const handle = makeTestDb();
const suite = handle ? describe : describe.skip;
let db: NonNullable<typeof handle>["db"];
// Imported in beforeAll, not statically: commands.ts loads the pooled client,
// which reads DATABASE_URL once at import - after makeTestDb points it at the
// scratch database, not before.
let commands: typeof import("@/domains/opportunities/commands");
let queries: typeof import("@/domains/opportunities/queries");

beforeAll(async () => {
  if (!handle) return;
  ({ db } = handle);
  commands = await import("@/domains/opportunities/commands");
  queries = await import("@/domains/opportunities/queries");
});

afterAll(async () => {
  await handle?.client.end();
});

async function seed(slug: string) {
  const { userId, workspaceId } = await seedWorkspace(db, `${slug}-${Date.now()}`);
  return ownerAuth(userId, workspaceId);
}

suite("opportunities pipeline", () => {
  it("creates with an opening history row and lists with company names", async () => {
    const auth = await seed("opp-basic");
    const crm = await import("@/domains/crm/commands");
    const company = await crm.createCompany(auth, { name: "Analytical Engines" });
    const opportunity = await commands.createOpportunity(auth, {
      title: "Staff AI Engineer",
      companyId: company.id,
      whyItMatters: "Strong fit",
      nextCommitment: "Send tailored resume",
    });

    const list = await queries.listOpportunities(auth, {});
    expect(list.map((row) => row.title)).toEqual(["Staff AI Engineer"]);
    expect(list[0].companyName).toBe("Analytical Engines");
    expect(list[0].stage).toBe("identified");

    const detail = await queries.getOpportunityDetail(auth, { opportunityId: opportunity.id });
    expect(detail?.history).toHaveLength(1);
    expect(detail?.history[0]).toMatchObject({ fromStage: null, toStage: "identified", note: "Created" });
  });

  it("records a stage change and its history atomically, and sets the outcome once", async () => {
    const auth = await seed("opp-stage");
    const opportunity = await commands.createOpportunity(auth, { title: "Consulting lead" });

    const moved = await commands.changeStage(auth, {
      opportunityId: opportunity.id,
      expectedVersion: opportunity.version,
      toStage: "preparing",
      note: "Drafting the proposal",
    });
    expect(moved.unchanged).toBe(false);

    let detail = await queries.getOpportunityDetail(auth, { opportunityId: opportunity.id });
    expect(detail?.opportunity.stage).toBe("preparing");
    expect(detail?.history[0]).toMatchObject({ fromStage: "identified", toStage: "preparing", note: "Drafting the proposal" });

    const won = await commands.changeStage(auth, {
      opportunityId: opportunity.id,
      expectedVersion: opportunity.version + 1,
      toStage: "won",
    });
    expect(won.unchanged).toBe(false);
    detail = await queries.getOpportunityDetail(auth, { opportunityId: opportunity.id });
    expect(detail?.opportunity.outcome).toBe("accepted");

    // Reopening does not rewrite the recorded outcome.
    await commands.changeStage(auth, {
      opportunityId: opportunity.id,
      expectedVersion: opportunity.version + 2,
      toStage: "negotiating",
    });
    detail = await queries.getOpportunityDetail(auth, { opportunityId: opportunity.id });
    expect(detail?.opportunity.outcome).toBe("accepted");

    const audits = await db.select().from(auditEvents).where(eq(auditEvents.workspaceId, auth.workspaceId));
    expect(audits.map((row) => row.action)).toContain("opportunity.stage_changed");
  });

  it("rejects a stale stage change and treats a same-stage move as a no-op", async () => {
    const auth = await seed("opp-stale");
    const opportunity = await commands.createOpportunity(auth, { title: "Stale target" });

    await expect(
      commands.changeStage(auth, {
        opportunityId: opportunity.id,
        expectedVersion: 99,
        toStage: "submitted",
      }),
    ).rejects.toBeInstanceOf(commands.StaleWriteError);

    const noop = await commands.changeStage(auth, {
      opportunityId: opportunity.id,
      expectedVersion: opportunity.version,
      toStage: "identified",
    });
    expect(noop.unchanged).toBe(true);
    const detail = await queries.getOpportunityDetail(auth, { opportunityId: opportunity.id });
    expect(detail?.history).toHaveLength(1); // only the creation row
  });

  it("isolates reads by workspace and rejects foreign ids", async () => {
    const a = await seed("opp-tenant-a");
    const b = await seed("opp-tenant-b");
    const opportunity = await commands.createOpportunity(a, { title: "Tenant A role" });

    expect(await queries.listOpportunities(b, {})).toHaveLength(0);
    expect(await queries.getOpportunityDetail(b, { opportunityId: opportunity.id })).toBeNull();
    await expect(
      commands.changeStage(b, { opportunityId: opportunity.id, expectedVersion: 1, toStage: "won" }),
    ).rejects.toBeInstanceOf(commands.NotFoundError);
  });

  it("tracks deadlines and marks them met exactly once", async () => {
    const auth = await seed("opp-deadline");
    const opportunity = await commands.createOpportunity(auth, { title: "Deadline role" });
    const deadline = await commands.addDeadline(auth, {
      opportunityId: opportunity.id,
      label: "Application closes",
      dueOn: "2026-10-25",
    });

    await commands.markDeadlineMet(auth, { deadlineId: deadline.id, expectedVersion: deadline.version });
    await expect(
      commands.markDeadlineMet(auth, { deadlineId: deadline.id, expectedVersion: deadline.version + 1 }),
    ).rejects.toBeInstanceOf(commands.StaleWriteError);

    const detail = await queries.getOpportunityDetail(auth, { opportunityId: opportunity.id });
    expect(detail?.deadlines[0].metAt).toBeTruthy();
  });

  it("archives out of list and detail", async () => {
    const auth = await seed("opp-archive");
    const opportunity = await commands.createOpportunity(auth, { title: "Old lead" });
    await commands.archiveOpportunity(auth, { opportunityId: opportunity.id, expectedVersion: opportunity.version });
    expect(await queries.listOpportunities(auth, {})).toHaveLength(0);
    expect(await queries.getOpportunityDetail(auth, { opportunityId: opportunity.id })).toBeNull();
  });
});
