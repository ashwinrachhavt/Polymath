import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { focusSessions } from "@/domains/focus/schema";
import { rewardDefinitions, rewardLedger } from "@/domains/gamification/schema";
import { makeTestDb, ownerAuth, seedWorkspace } from "../helpers/test-workspace";

/*
 * Spec §7 foundry flow, at the command level: a malformed recipe never
 * becomes a proposal; the gen- namespace dedupes proposals and definitions;
 * approve writes exactly one collectible whose recipe is what the page
 * renders; and a deep finish's drop is a 25% server-side roll capped at one
 * stone per user per day by the ledger's own idempotency key.
 */

const handle = makeTestDb();
let db: NonNullable<typeof handle>["db"];
// The domain modules open the pool at import time, so they load only after
// the harness has pointed DATABASE_URL at the scratch database.
let commands: typeof import("@/domains/gamification/commands");
let proposals: typeof import("@/domains/gamification/proposals");
let queries: typeof import("@/domains/gamification/queries");
let decideProposal: (typeof import("@/domains/actions/commands"))["decideProposal"];

beforeAll(async () => {
  ({ db } = handle);
  commands = await import("@/domains/gamification/commands");
  proposals = await import("@/domains/gamification/proposals");
  queries = await import("@/domains/gamification/queries");
  ({ decideProposal } = await import("@/domains/actions/commands"));
});

afterAll(async () => {
  await handle.client.end();
});

const SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200"><path d="M100 20 L170 90 L100 180 L30 90 Z" fill="#7C3AED"/></svg>';

const RECIPE = {
  name: "Amethyst of Patience",
  rarity: "Rare" as const,
  theme: "Deep work that holds",
  palette: ["#7C3AED", "#A78BFA", "#C4B5FD"],
  svg: SVG,
};

async function seed(slug: string) {
  const { userId, workspaceId } = await seedWorkspace(db, `${slug}-${Date.now()}`);
  return ownerAuth(userId, workspaceId);
}

type Auth = Awaited<ReturnType<typeof seed>>;

/** Propose one stone and approve it through the owner's one-tap path. */
async function forgeOne(auth: Auth, name: string) {
  await proposals.proposeStone(auth, { ...RECIPE, name, dedupeId: `forge-${name}` });
  const [pending] = await queries.listFoundryProposals(auth);
  return proposals.approveStoneProposal(auth, {
    proposalId: pending.proposalId,
    expectedVersion: pending.expectedVersion,
    revisionId: pending.revisionId,
  });
}

async function drop(auth: Auth, sessionId: string, roll: number) {
  // The command runs inside the focus transaction in production; here the
  // same wrapper gives it a real transaction to roll back on failure.
  const { withTransaction } = await import("@/lib/db-transaction");
  return withTransaction((tx) => commands.recordFoundryDrop(tx, auth, sessionId, roll));
}

describe("foundry proposals", () => {
  it("never persists a malformed recipe", async () => {
    const auth = await seed("foundry-malformed");
    await expect(
      proposals.proposeStone(auth, {
        ...RECIPE,
        svg: '<svg viewBox="0 0 200 200"><script>alert(1)</script></svg>',
        dedupeId: "bad-1",
      }),
    ).rejects.toThrow();
    expect(await queries.listFoundryProposals(auth)).toHaveLength(0);
  });

  it("dedupes a replayed dedupeId instead of queueing a second stone", async () => {
    const auth = await seed("foundry-dedupe");
    const first = await proposals.proposeStone(auth, { ...RECIPE, dedupeId: "attempt-1" });
    const replay = await proposals.proposeStone(auth, { ...RECIPE, dedupeId: "attempt-1" });
    expect(replay.proposalId).toBe(first.proposalId);
    expect(replay.deduplicated).toBe(true);

    const rival = await proposals.proposeStone(auth, { ...RECIPE, dedupeId: "attempt-2" });
    expect(rival.proposalId).not.toBe(first.proposalId);
    expect(rival.deduplicated).toBe(false);
  });

  it("carries the parsed recipe through proposal, approval, and the render path", async () => {
    const auth = await seed("foundry-approve");
    await proposals.proposeStone(auth, { ...RECIPE, dedupeId: "render-1" });
    const [pending] = await queries.listFoundryProposals(auth);
    expect(pending.recipe).toMatchObject({ name: "Amethyst of Patience", rarity: "Rare" });
    expect(pending.expectedVersion).toBe(1);

    const approved = await proposals.approveStoneProposal(auth, {
      proposalId: pending.proposalId,
      expectedVersion: pending.expectedVersion,
      revisionId: pending.revisionId,
    });
    expect(approved.key).toBe("gen-amethyst-of-patience");
    expect(approved.deduplicated).toBe(false);

    const [definition] = await db
      .select()
      .from(rewardDefinitions)
      .where(eq(rewardDefinitions.workspaceId, auth.workspaceId));
    expect(definition.kind).toBe("collectible");
    expect(definition.points).toBe(0);
    expect(definition.recipe).toMatchObject({ name: "Amethyst of Patience", svg: SVG });

    // The render path: the decided proposal leaves the queue and the
    // definition's recipe is what the forged shelf renders.
    expect(await queries.listFoundryProposals(auth)).toHaveLength(0);
    const overview = await queries.getRewardsOverview(auth);
    expect(overview.definitions.find((d) => d.key === approved.key)?.recipe).toMatchObject({
      name: "Amethyst of Patience",
    });
  });

  it("resolves two proposals for the same design to one definition", async () => {
    const auth = await seed("foundry-collision");
    await forgeOne(auth, "Duplicate Design");
    await proposals.proposeStone(auth, { ...RECIPE, name: "Duplicate Design", dedupeId: "attempt-2" });
    const [pending] = await queries.listFoundryProposals(auth);
    const approved = await proposals.approveStoneProposal(auth, {
      proposalId: pending.proposalId,
      expectedVersion: pending.expectedVersion,
      revisionId: pending.revisionId,
    });
    expect(approved.key).toBe("gen-duplicate-design");
    expect(approved.deduplicated).toBe(true);

    const rows = await db.select().from(rewardDefinitions).where(eq(rewardDefinitions.workspaceId, auth.workspaceId));
    expect(rows).toHaveLength(1);
  });

  it("records a rejection and creates nothing", async () => {
    const auth = await seed("foundry-reject");
    await proposals.proposeStone(auth, { ...RECIPE, dedupeId: "reject-1" });
    const [pending] = await queries.listFoundryProposals(auth);
    await decideProposal(auth, {
      proposalId: pending.proposalId,
      expectedVersion: pending.expectedVersion,
      revisionId: pending.revisionId,
      decision: "rejected",
      idempotencyKey: `stones-decide:${pending.proposalId}`,
    });
    expect(await queries.listFoundryProposals(auth)).toHaveLength(0);
    const rows = await db.select().from(rewardDefinitions).where(eq(rewardDefinitions.workspaceId, auth.workspaceId));
    expect(rows).toHaveLength(0);
  });
});

describe("foundry drops", () => {
  it("rolls exactly the 25% chance, and only below it", () => {
    expect(commands.FOUNDRY_DROP_CHANCE).toBe(0.25);
    expect(commands.foundryDropWins(0)).toBe(true);
    expect(commands.foundryDropWins(0.2499)).toBe(true);
    expect(commands.foundryDropWins(0.25)).toBe(false);
    expect(commands.foundryDropWins(0.9999)).toBe(false);
  });

  it("drops one designed stone on a winning roll, capped at one per user per day", async () => {
    const auth = await seed("foundry-drop");
    await forgeOne(auth, "Drop Stone");
    // subject_id is a uuid column - the production caller passes the focus
    // session's id; the tests need real-shaped ids too.
    const firstSession = crypto.randomUUID();
    const secondSession = crypto.randomUUID();

    // A losing roll lands nothing.
    expect(await drop(auth, firstSession, 0.5)).toBe(false);
    expect(await db.select().from(rewardLedger).where(eq(rewardLedger.workspaceId, auth.workspaceId))).toHaveLength(0);

    // A winning roll drops exactly one stone, on the ledger's day key.
    expect(await drop(auth, firstSession, 0.1)).toBe(true);
    const ledger = await db.select().from(rewardLedger).where(eq(rewardLedger.workspaceId, auth.workspaceId));
    expect(ledger).toHaveLength(1);
    expect(ledger[0].reason).toBe("foundry_drop");
    expect(ledger[0].idempotencyKey).toMatch(/^foundry-drop:.+:\d{4}-\d{2}-\d{2}$/);

    // The cap: a second winning roll the same day is a silent skip.
    expect(await drop(auth, secondSession, 0.2)).toBe(false);
    expect(await db.select().from(rewardLedger).where(eq(rewardLedger.workspaceId, auth.workspaceId))).toHaveLength(1);
  });

  it("wins nothing when the foundry is empty", async () => {
    const auth = await seed("foundry-empty");
    expect(await drop(auth, crypto.randomUUID(), 0.1)).toBe(false);
    expect(await db.select().from(rewardLedger).where(eq(rewardLedger.workspaceId, auth.workspaceId))).toHaveLength(0);
  });

  it("rides a real deep finish, and only a deep finish", async () => {
    const auth = await seed("foundry-deep");
    await forgeOne(auth, "Deep Finish Stone");
    const focus = await import("@/domains/focus/commands");

    const spy = vi.spyOn(Math, "random").mockReturnValue(0.1);
    try {
      // A normal-tier finish that wins the roll drops nothing.
      const normal = await focus.startFocusSession(auth, { subject: "Normal", plannedMinutes: 25 });
      await focus.finishFocusSession(auth, { sessionId: normal.id, expectedVersion: normal.version, outcome: "Done" });
      let ledger = await db.select().from(rewardLedger).where(eq(rewardLedger.workspaceId, auth.workspaceId));
      expect(ledger.filter((row) => row.reason === "foundry_drop")).toHaveLength(0);

      // A deep finish holds its planned time, then rolls: the drop lands
      // inside the finish's own transaction.
      const deep = await focus.startFocusSession(auth, { subject: "Deep", plannedMinutes: 1, strictness: "deep" });
      const past = new Date(Date.now() - 61_000);
      await db.update(focusSessions).set({ startedAt: past, lastResumedAt: past }).where(eq(focusSessions.id, deep.id));
      await focus.finishFocusSession(auth, { sessionId: deep.id, expectedVersion: deep.version, outcome: "Held" });
      ledger = await db.select().from(rewardLedger).where(eq(rewardLedger.workspaceId, auth.workspaceId));
      expect(ledger.filter((row) => row.reason === "foundry_drop")).toHaveLength(1);
    } finally {
      spy.mockRestore();
    }
  });
});
