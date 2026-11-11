import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq, or, sql } from "drizzle-orm";
import {
  artifactLinks,
  artifactVersions,
  artifacts,
  claims,
  documentExtractions,
  documents,
  embeddings,
  tidyFindings,
} from "@/domains/knowledge/schema";
import type { IdeaComparator } from "@/integrations/zettels/extractor";
import { makeTestDb, ownerAuth, seedWorkspace } from "../helpers/test-workspace";

/*
 * Tidy against real Postgres. Vectors are hand-written: the stubbed provider
 * embeds every claim as the unit vector e1, and a seeded card sits at a
 * chosen cosine distance d from e1, so "near" and "far" are exact.
 */

const handle = makeTestDb();
const suite = handle ? describe : describe.skip;
const holder: { db: ReturnType<typeof import("drizzle-orm/postgres-js").drizzle> | undefined } = { db: undefined };
vi.mock("@/lib/db", () => ({
  get db() {
    return holder.db;
  },
}));

vi.mock("@/integrations/embeddings/provider", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/integrations/embeddings/provider")>();
  return {
    ...actual,
    embeddingProvider: () => ({
      model: "test-embed",
      embed: async () => [[1, ...Array.from({ length: actual.EMBEDDING_DIMENSIONS - 1 }, () => 0)]],
    }),
  };
});

beforeAll(() => {
  holder.db = handle?.db;
});
afterAll(async () => {
  await handle?.client.end();
});

type Auth = ReturnType<typeof ownerAuth>;

const vectorAt = (d: number) => {
  const c = 1 - d;
  return [c, Math.sqrt(1 - c * c), ...Array.from({ length: 1534 }, () => 0)];
};

async function seedAuth(label: string): Promise<Auth> {
  const seed = await seedWorkspace(holder.db!, `tidy-${label}-${Date.now()}`);
  return ownerAuth(seed.userId, seed.workspaceId);
}

/** A note or idea with a current version, optionally embedded at distance `d` from e1 and aged `ageDays`. */
async function seedCard(
  auth: Auth,
  input: { kind: "note" | "zettel"; title: string; body: string; d?: number; ageDays?: number },
) {
  const db = holder.db!;
  const createdAt = new Date(Date.now() - (input.ageDays ?? 0) * 86_400_000);
  const [card] = await db
    .insert(artifacts)
    .values({
      workspaceId: auth.workspaceId,
      kind: input.kind,
      title: input.title,
      status: input.kind === "zettel" ? "generated" : "draft",
      createdBy: auth.userId,
      updatedBy: auth.userId,
      createdAt,
    })
    .returning();
  const [version] = await db
    .insert(artifactVersions)
    .values({
      workspaceId: auth.workspaceId,
      artifactId: card.id,
      versionNumber: 1,
      content: { type: "doc", content: [] },
      plainText: input.body,
      reason: "created",
      createdBy: auth.userId,
    })
    .returning();
  await db.update(artifacts).set({ currentVersionId: version.id }).where(eq(artifacts.id, card.id));
  if (input.kind === "zettel") {
    await db.insert(claims).values({
      workspaceId: auth.workspaceId,
      artifactId: card.id,
      statement: input.body,
      status: "proposed",
      createdBy: auth.userId,
      updatedBy: auth.userId,
    });
  }
  if (input.d !== undefined) {
    await db.insert(embeddings).values({
      workspaceId: auth.workspaceId,
      ownerType: "artifact",
      ownerId: card.id,
      chunkIndex: 0,
      content: input.body,
      model: "test-embed",
      embedding: vectorAt(input.d),
    });
  }
  return card.id;
}

async function findingRows(auth: Auth) {
  return holder
    .db!.select()
    .from(tidyFindings)
    .where(eq(tidyFindings.workspaceId, auth.workspaceId))
    .orderBy(tidyFindings.createdAt);
}

async function pairLinks(auth: Auth, a: string, b: string) {
  return holder
    .db!.select({
      from: artifactLinks.artifactId,
      to: artifactLinks.targetId,
      linkType: artifactLinks.linkType,
      context: artifactLinks.context,
    })
    .from(artifactLinks)
    .where(
      and(
        eq(artifactLinks.workspaceId, auth.workspaceId),
        or(
          and(eq(artifactLinks.artifactId, a), eq(artifactLinks.targetId, b)),
          and(eq(artifactLinks.artifactId, b), eq(artifactLinks.targetId, a)),
        ),
      ),
    );
}

const judgeSaying = (verdict: Awaited<ReturnType<IdeaComparator>>) => {
  const compare = vi.fn<IdeaComparator>(async () => verdict);
  return { compare, judge: { embeddingModel: "test-embed", compare } };
};

suite("Tidy (real Postgres)", () => {
  it("reading a source whose idea contradicts an existing one records the finding and a contradicts link", async () => {
    const auth = await seedAuth("read");
    const existing = await seedCard(auth, {
      kind: "zettel",
      title: "Rent is due monthly",
      body: "Rent is due on the first.",
      d: 0.1,
    });
    const quote = "Rent is due every Friday.";
    const text = `Lease terms. ${quote} End.`;
    const [document] = await holder
      .db!.insert(documents)
      .values({
        workspaceId: auth.workspaceId,
        title: "Lease",
        mimeType: "text/plain",
        createdBy: auth.userId,
        updatedBy: auth.userId,
      })
      .returning();
    await holder.db!.insert(documentExtractions).values({
      workspaceId: auth.workspaceId,
      documentId: document.id,
      contentHash: crypto.randomUUID(),
      status: "succeeded",
      text,
      extractor: "fixture@1",
    });
    const reason = "One says monthly, the other weekly.";
    const extractor = {
      name: "fake",
      extract: async () => [{ title: "Rent is due weekly", content: "Rent is due every Friday.", quote }],
      compareIdeas: async () => ({ verdict: "contradicts" as const, reason }),
    };

    const { createZettelsFromSource } = await import("@/domains/knowledge/zettels");
    const result = await createZettelsFromSource(auth, { documentId: document.id, extractor });
    expect(result.created).toHaveLength(1);
    const created = result.created[0].artifactId;

    const { listTidyFindings } = await import("@/domains/knowledge/tidy");
    const { findings } = await listTidyFindings(auth);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      kind: "disagreement",
      otherId: existing,
      detail: { reason },
      subject: { id: created, title: "Rent is due weekly", sourceQuote: quote, sourceTitle: "Lease" },
      other: { id: existing, title: "Rent is due monthly" },
    });
    expect(await pairLinks(auth, created, existing)).toEqual([
      { from: created, to: existing, linkType: "contradicts", context: reason },
    ]);
  });

  it("a pass run twice raises each finding once and asks the model once", async () => {
    const auth = await seedAuth("twice");
    const first = await seedCard(auth, {
      kind: "zettel",
      title: "Sleep consolidates memory",
      body: "Sleep consolidates memory.",
      d: 0,
    });
    const second = await seedCard(auth, {
      kind: "zettel",
      title: "Memory needs sleep",
      body: "Memory is consolidated in sleep.",
      d: 0.02,
    });
    const third = await seedCard(auth, {
      kind: "zettel",
      title: "Sleep hurts memory",
      body: "Sleep erases memory.",
      d: 0.134,
    });
    const { compare, judge } = judgeSaying({ verdict: "contradicts", reason: "Opposite effects of sleep." });
    const { runTidyPass } = await import("@/domains/knowledge/tidy");

    const once = await runTidyPass(auth, { judge });
    const twice = await runTidyPass(auth, { judge });

    const rows = await findingRows(auth);
    expect(rows.map((row) => row.kind).sort()).toEqual(["disagreement", "disagreement", "duplicate"]);
    expect(new Set(rows.map((row) => row.dedupeKey)).size).toBe(rows.length);
    const duplicate = rows.find((row) => row.kind === "duplicate")!;
    expect([duplicate.subjectId, duplicate.otherId].sort()).toEqual([first, second].sort());
    // first-third and second-third are the only pairs needing a model.
    expect(compare).toHaveBeenCalledTimes(2);
    expect(once.pairReview).toMatchObject({
      status: "ran",
      reviewed: 3,
      comparisons: 2,
      disagreements: 2,
      duplicates: 1,
    });
    expect(twice.pairReview).toMatchObject({ status: "ran", reviewed: 0, comparisons: 0 });
    expect((await pairLinks(auth, first, third))[0]?.linkType).toBe("contradicts");
  });

  it("two overlapping passes leave one row per finding", async () => {
    const auth = await seedAuth("overlap");
    await seedCard(auth, { kind: "note", title: "Lonely note", body: "Nothing links here.", ageDays: 9 });
    await seedCard(auth, { kind: "zettel", title: "A", body: "A.", d: 0 });
    await seedCard(auth, { kind: "zettel", title: "B", body: "B.", d: 0.01 });
    const { runTidyPass } = await import("@/domains/knowledge/tidy");
    await Promise.all([
      runTidyPass(auth, { judge: judgeSaying({ verdict: "distinct" }).judge }),
      runTidyPass(auth, { judge: judgeSaying({ verdict: "distinct" }).judge }),
    ]);
    const rows = await findingRows(auth);
    expect(rows.map((row) => row.kind).sort()).toEqual(["duplicate", "unlinked"]);
  });

  it("a dismissed finding does not come back", async () => {
    const auth = await seedAuth("dismiss");
    const note = await seedCard(auth, { kind: "note", title: "Orphan", body: "Alone.", ageDays: 10 });
    const first = await seedCard(auth, { kind: "zettel", title: "Tea calms", body: "Tea calms.", d: 0 });
    const second = await seedCard(auth, { kind: "zettel", title: "Tea excites", body: "Tea excites.", d: 0.1 });
    const { judge } = judgeSaying({ verdict: "contradicts", reason: "Calm versus excited." });
    const { dismissFinding, listTidyFindings, runTidyPass } = await import("@/domains/knowledge/tidy");
    await runTidyPass(auth, { judge });

    const { findings } = await listTidyFindings(auth);
    expect(findings.map((f) => f.kind).sort()).toEqual(["disagreement", "unlinked"]);
    for (const finding of findings) await dismissFinding(auth, { findingId: finding.id });

    // Forget the review stamps so the pair is judged again from scratch.
    await holder.db!.update(artifacts).set({ metadata: null }).where(eq(artifacts.workspaceId, auth.workspaceId));
    await runTidyPass(auth, { judge });

    expect((await listTidyFindings(auth)).findings).toEqual([]);
    const rows = await findingRows(auth);
    expect(rows.map((row) => [row.kind, row.status]).sort()).toEqual([
      ["disagreement", "dismissed"],
      ["unlinked", "dismissed"],
    ]);
    expect(rows.find((row) => row.kind === "unlinked")?.subjectId).toBe(note);
    expect((await pairLinks(auth, first, second)).map((link) => link.linkType)).toEqual(["dismissed"]);
  });

  it("an unlinked note's finding clears once it is linked and reopens if the link goes", async () => {
    const auth = await seedAuth("unlinked");
    const note = await seedCard(auth, { kind: "note", title: "Loose", body: "Loose end.", ageDays: 8 });
    const fresh = await seedCard(auth, { kind: "note", title: "Fresh", body: "Written today.", ageDays: 0 });
    const { runTidyPass, listTidyFindings } = await import("@/domains/knowledge/tidy");
    const { linkCards, removeLink } = await import("@/domains/knowledge/relations");

    await runTidyPass(auth, { judge: null });
    const open = (await listTidyFindings(auth)).findings;
    expect(open.map((f) => [f.kind, f.subject.id])).toEqual([["unlinked", note]]);

    await linkCards(auth, { artifactId: note, targetId: fresh });
    const linked = await runTidyPass(auth, { judge: null });
    expect(linked.cleared).toBe(1);
    expect((await listTidyFindings(auth)).findings).toEqual([]);
    expect((await findingRows(auth)).map((row) => row.status)).toEqual(["cleared"]);

    await removeLink(auth, { artifactId: note, targetId: fresh });
    const unlinkedAgain = await runTidyPass(auth, { judge: null });
    expect(unlinkedAgain.opened).toBe(1);
    expect((await listTidyFindings(auth)).findings.map((f) => f.subject.id)).toEqual([note]);
  });

  it("with no model configured the pass still finds loose ends", async () => {
    const auth = await seedAuth("nomodel");
    await seedCard(auth, { kind: "zettel", title: "Existing idea", body: "Exists.", d: 0 });
    await seedCard(auth, { kind: "zettel", title: "Twin idea", body: "Twin.", d: 0.01 });
    const note = await seedCard(auth, {
      kind: "note",
      title: "Index",
      body: "See [[Existing idea]] and [[Nowhere to be found]].",
      ageDays: 1,
    });
    const { runTidyPass, listTidyFindings } = await import("@/domains/knowledge/tidy");

    const summary = await runTidyPass(auth, { judge: null });
    expect(summary.pairReview).toEqual({ status: "skipped", reason: "no_model" });
    const { findings } = await listTidyFindings(auth);
    expect(findings.map((f) => [f.kind, f.subject.id, f.detail])).toEqual([
      ["broken_link", note, { linkTitle: "Nowhere to be found" }],
    ]);
    // Pair review never ran, so the near-identical ideas were not stamped.
    const stamped = await holder
      .db!.select({ id: artifacts.id })
      .from(artifacts)
      .where(and(eq(artifacts.workspaceId, auth.workspaceId), sql`${artifacts.metadata} ? 'tidy'`));
    expect(stamped).toEqual([]);
  });

  it("an idea whose source document was archived is out of date", async () => {
    const auth = await seedAuth("source");
    const idea = await seedCard(auth, { kind: "zettel", title: "From a lease", body: "A lease idea." });
    const [document] = await holder
      .db!.insert(documents)
      .values({ workspaceId: auth.workspaceId, title: "Old lease", mimeType: "text/plain", archivedAt: new Date() })
      .returning();
    await holder.db!.insert(artifactLinks).values({
      workspaceId: auth.workspaceId,
      artifactId: idea,
      targetType: "document",
      targetId: document.id,
      linkType: "source",
      label: "Old lease",
    });
    const { runTidyPass, listTidyFindings } = await import("@/domains/knowledge/tidy");
    await runTidyPass(auth, { judge: null });
    expect((await listTidyFindings(auth)).findings.map((f) => [f.kind, f.subject.id, f.detail])).toEqual([
      ["source_changed", idea, { documentId: document.id, cause: "archived" }],
    ]);
  });

  it("resolving a disagreement writes the link its outcome describes", async () => {
    const auth = await seedAuth("resolve");
    const { recordDisagreement, resolveDisagreement, listTidyFindings, TidyTransitionError } =
      await import("@/domains/knowledge/tidy");
    const { withTransaction } = await import("@/lib/db-transaction");
    const pair = async (label: string) => {
      const a = await seedCard(auth, { kind: "zettel", title: `${label} first`, body: "First." });
      const b = await seedCard(auth, { kind: "zettel", title: `${label} second`, body: "Second." });
      await withTransaction((tx) => recordDisagreement(tx, auth, { subjectId: a, otherId: b, reason: "They clash." }));
      const finding = (await listTidyFindings(auth)).findings.find((f) => f.subject.id === a)!;
      return { a, b, findingId: finding.id };
    };

    const firstHolds = await pair("p1");
    await resolveDisagreement(auth, {
      findingId: firstHolds.findingId,
      outcome: "first_holds",
      note: "Checked the source.",
    });
    expect(await pairLinks(auth, firstHolds.a, firstHolds.b)).toEqual([
      { from: firstHolds.a, to: firstHolds.b, linkType: "contradicts", context: "Checked the source." },
    ]);

    const secondHolds = await pair("p2");
    await resolveDisagreement(auth, { findingId: secondHolds.findingId, outcome: "second_holds" });
    expect(await pairLinks(auth, secondHolds.a, secondHolds.b)).toEqual([
      { from: secondHolds.b, to: secondHolds.a, linkType: "contradicts", context: "They clash." },
    ]);

    const bothHold = await pair("p3");
    await resolveDisagreement(auth, { findingId: bothHold.findingId, outcome: "both_hold", note: "Different scopes." });
    expect(await pairLinks(auth, bothHold.a, bothHold.b)).toEqual([
      { from: bothHold.a, to: bothHold.b, linkType: "contrasts", context: "Different scopes." },
    ]);

    const rows = await findingRows(auth);
    expect(rows.map((row) => [row.status, row.resolution])).toEqual([
      ["resolved", "first_holds"],
      ["resolved", "second_holds"],
      ["resolved", "both_hold"],
    ]);
    expect(rows[0].resolutionNote).toBe("Checked the source.");
    await expect(
      resolveDisagreement(auth, { findingId: firstHolds.findingId, outcome: "both_hold" }),
    ).rejects.toBeInstanceOf(TidyTransitionError);
    expect((await listTidyFindings(auth)).findings).toEqual([]);
  });

  it("never shows or touches another workspace's findings or notes", async () => {
    const mine = await seedAuth("ws-a");
    const theirs = await seedAuth("ws-b");
    const theirNote = await seedCard(theirs, { kind: "note", title: "Their orphan", body: "Theirs.", ageDays: 30 });
    const theirIdea = await seedCard(theirs, { kind: "zettel", title: "Their idea", body: "Theirs.", d: 0 });
    const myIdea = await seedCard(mine, { kind: "zettel", title: "My idea", body: "Mine.", d: 0 });
    const { runTidyPass, listTidyFindings, dismissFinding, resolveDisagreement, TidyFindingNotFoundError } =
      await import("@/domains/knowledge/tidy");

    await runTidyPass(theirs, { judge: null });
    const [theirFinding] = (await listTidyFindings(theirs)).findings;
    expect(theirFinding.subject.id).toBe(theirNote);

    const { compare, judge } = judgeSaying({ verdict: "same" });
    const summary = await runTidyPass(mine, { judge });
    expect(compare).not.toHaveBeenCalled();
    expect(summary.pairReview).toMatchObject({ duplicates: 0 });
    expect((await listTidyFindings(mine)).findings).toEqual([]);
    expect(await findingRows(mine)).toEqual([]);

    await expect(dismissFinding(mine, { findingId: theirFinding.id })).rejects.toBeInstanceOf(TidyFindingNotFoundError);
    await expect(
      resolveDisagreement(mine, { findingId: theirFinding.id, outcome: "first_holds" }),
    ).rejects.toBeInstanceOf(TidyFindingNotFoundError);
    expect((await findingRows(theirs)).map((row) => row.status)).toEqual(["open"]);
    expect(await pairLinks(mine, myIdea, theirIdea)).toEqual([]);
  });

  it("schedules one pass per workspace per day and the handler runs it as the owner", async () => {
    const auth = await seedAuth("schedule");
    await seedCard(auth, { kind: "note", title: "Scheduled orphan", body: "Alone.", ageDays: 20 });
    const { scheduleDailyTidyPasses, tidyPassRequestedHandler, listTidyFindings } =
      await import("@/domains/knowledge/tidy");
    const day = new Date("2026-11-10T08:00:00Z");
    const first = await scheduleDailyTidyPasses(day);
    const again = await scheduleDailyTidyPasses(day);
    expect(first.enqueued).toBeGreaterThanOrEqual(1);
    expect(again.enqueued).toBe(0);

    const handler = tidyPassRequestedHandler(async (workspaceId) => (workspaceId === auth.workspaceId ? auth : null));
    await handler({
      id: crypto.randomUUID(),
      workspaceId: auth.workspaceId,
      topic: "knowledge.tidy_pass_requested",
      payload: {},
      attempts: 1,
      leaseToken: "t",
    });
    expect((await listTidyFindings(auth)).findings.map((f) => f.kind)).toEqual(["unlinked"]);
  });
});
