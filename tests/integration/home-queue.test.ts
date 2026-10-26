import { randomUUID } from "crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { actionProposals, actionRevisions } from "@/domains/actions/schema";
import { captureProposals } from "@/domains/capture/schema";
import { makeTestDb, ownerAuth, seedWorkspace } from "../helpers/test-workspace";

/*
 * ASH-309: the homepage queue merges every proposer - agents and capture
 * classification - workspace-scoped, ranked by the pinned order, each card
 * carrying what its one-tap decide binds. CI's pgvector service runs this.
 */

const handle = makeTestDb();
const suite = handle ? describe : describe.skip;
let db: NonNullable<typeof handle>["db"];
let queue: typeof import("@/domains/home/queue");
let commands: typeof import("@/domains/capture/commands");

beforeAll(async () => {
  if (!handle) return;
  ({ db } = handle);
  queue = await import("@/domains/home/queue");
  commands = await import("@/domains/capture/commands");
});

afterAll(async () => {
  await handle?.client.end();
});

async function seed(slug: string) {
  const { userId, workspaceId } = await seedWorkspace(db, `${slug}-${Date.now()}`);
  return ownerAuth(userId, workspaceId);
}

async function seedActionProposal(auth: { workspaceId: string; userId: string }, input: { title: string; riskClass: "prepare" | "external_write" | "sensitive_write"; expiresAt?: Date }) {
  const [proposal] = await db
    .insert(actionProposals)
    .values({
      workspaceId: auth.workspaceId,
      capability: "gmail.send",
      riskClass: input.riskClass,
      title: input.title,
      expectedEffect: `Effect of ${input.title}`,
      dedupeKey: randomUUID(),
      expiresAt: input.expiresAt ?? null,
      createdBy: auth.userId,
      updatedBy: auth.userId,
    })
    .returning();
  const [revision] = await db
    .insert(actionRevisions)
    .values({
      workspaceId: auth.workspaceId,
      proposalId: proposal.id,
      revisionNumber: 1,
      payload: { to: "priya@example.com" },
      createdBy: auth.userId,
    })
    .returning();
  return { proposal, revision };
}

suite("home queue", () => {
  it("merges agent and capture proposals into one ranked queue", async () => {
    const auth = await seed("home-queue-merge");
    const expiring = await seedActionProposal(auth, {
      title: "Send the roadmap email",
      riskClass: "external_write",
      expiresAt: new Date(Date.now() + 3600_000),
    });
    const timeless = await seedActionProposal(auth, { title: "Archive old threads", riskClass: "prepare" });
    const capture = await commands.createCapture(auth, { text: "Renew the passport before the trip" });
    await db.insert(captureProposals).values({
      workspaceId: auth.workspaceId,
      captureId: capture.id,
      kind: "task",
      payload: {},
      rationale: "task 0.9",
      confidence: "0.9",
      createdBy: auth.userId,
      updatedBy: auth.userId,
    });

    const cards = await queue.listHomeQueue(auth.workspaceId);
    expect(cards.map((c) => c.title)).toEqual(["Send the roadmap email", "Archive old threads", "Renew the passport before the trip"]);
    expect(cards[0].origin).toBe("agent");
    expect(cards[2].origin).toBe("capture");
    // One-tap decide binds: agent cards carry revision + CAS version, capture cards their kind.
    expect(cards[0].decision).toEqual({ kind: "agent", revisionId: expiring.revision.id, version: expiring.proposal.version, expired: false });
    expect(cards[2].decision).toEqual({ kind: "capture" });
    expect(cards[2].effect).toBe("Becomes a task.");
    expect(cards[2].href).toContain(capture.id);
    void timeless;
  });

  it("never shows another workspace's proposals", async () => {
    const mine = await seed("home-queue-mine");
    const theirs = await seed("home-queue-theirs");
    await seedActionProposal(theirs, { title: "Their secret send", riskClass: "sensitive_write" });
    const cards = await queue.listHomeQueue(mine.workspaceId);
    expect(cards.map((c) => c.title)).not.toContain("Their secret send");
  });

  it("decided proposals leave the queue", async () => {
    const auth = await seed("home-queue-decided");
    const { proposal } = await seedActionProposal(auth, { title: "Done thing", riskClass: "prepare" });
    await db.update(actionProposals).set({ status: "rejected", updatedAt: new Date(), updatedBy: auth.userId }).where(eq(actionProposals.id, proposal.id));
    const cards = await queue.listHomeQueue(auth.workspaceId);
    expect(cards.map((c) => c.title)).not.toContain("Done thing");
  });
});
