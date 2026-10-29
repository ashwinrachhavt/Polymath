import { drizzle } from "drizzle-orm/postgres-js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { artifactLinks } from "@/domains/knowledge/schema";
import { tasks } from "@/domains/work/schema";
import { commitDecomposition, findSimilarZettels, type DecompositionAnalysis } from "@/domains/knowledge/decomposition";
import { createNote, getNote } from "@/domains/knowledge/notes";
import { createSitting, listSittingCards } from "@/domains/knowledge/sittings";
import { makeTestDb, ownerAuth, seedWorkspace } from "../helpers/test-workspace";

/*
 * §4 review decisions, server side: similarity candidates are shown (never
 * asserted), merge folds a candidate into an existing zettel through the
 * version machinery (kind untouched, version claimed, receipt-keyed), and
 * link records an explicit "related" edge the semantic pass leaves alone.
 */

const handle = makeTestDb();
const holder: { db: ReturnType<typeof drizzle> | undefined } = { db: undefined };
vi.mock("@/lib/db", () => ({ get db() { return holder.db; } }));
vi.mock("@/lib/db-transaction", () => ({
  get withTransaction() {
    return (fn: Parameters<typeof import("@/lib/db-transaction").withTransaction>[0]) =>
      (holder.db!.transaction as typeof import("@/lib/db-transaction").withTransaction)(fn);
  },
}));

const suite = handle ? describe : describe.skip;

function analysisWith(candidate: { id: string; title: string; content: string }): DecompositionAnalysis {
  return {
    sourceHash: "testhash",
    omitted: [],
    candidates: [
      {
        id: candidate.id,
        role: "principle",
        kind: "extraction",
        title: candidate.title,
        content: candidate.content,
        spans: [{ start: 0, end: 11, quote: "quoted text" }],
        similar: [],
      },
    ],
  };
}

suite("decomposition merge/link decisions (integration)", () => {
  let ws: { userId: string; workspaceId: string };
  let otherWs: { userId: string; workspaceId: string };

  beforeAll(async () => {
    holder.db = handle?.db;
    ws = await seedWorkspace(handle!.db, `dml-a-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    otherWs = await seedWorkspace(handle!.db, `dml-b-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  });

  afterAll(async () => {
    await handle?.client.end();
  });

  it("findSimilarZettels shows title-overlap matches and nothing else", async () => {
    const auth = ownerAuth(ws.userId, ws.workspaceId);
    await createNote(auth, {
      idempotencyKey: `dml-sim-1-${Date.now()}`,
      title: "Graph traversal heuristics",
      content: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "bfs" }] }] },
      plainText: "bfs",
      kind: "zettel",
    });
    await createNote(auth, {
      idempotencyKey: `dml-sim-2-${Date.now()}`,
      title: "Sourdough hydration",
      content: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "bread" }] }] },
      plainText: "bread",
      kind: "zettel",
    });
    const similar = await findSimilarZettels(auth, "Graph traversal in practice");
    expect(similar.length).toBe(1);
    expect(similar[0].title).toBe("Graph traversal heuristics");
  });

  it("merge appends a new version through the snapshot machinery, kind untouched, idempotent", async () => {
    const auth = ownerAuth(ws.userId, ws.workspaceId);
    const target = await createNote(auth, {
      idempotencyKey: `dml-merge-${Date.now()}`,
      title: "Merge target card",
      content: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "original" }] }] },
      plainText: "original",
      kind: "zettel",
    });
    const analysis = analysisWith({ id: "cand-merge", title: "Merge target card addition", content: "the folded-in idea" });
    const input = { analysis, decisions: [{ candidateId: "cand-merge", action: "merge" as const, targetArtifactId: target.id }], idempotencyKey: `dml-batch-${Date.now()}` };
    const first = await commitDecomposition(auth, input);
    expect(first.merged.length).toBe(1);
    expect(first.created.length).toBe(0);
    const after = await getNote(auth, target.id);
    expect(after?.kind).toBe("zettel");
    expect(after?.version).toBe(2);
    expect(JSON.stringify(after?.content)).toContain("the folded-in idea");
    // Retry with the same batch key: the snapshot receipt makes it a no-op.
    const second = await commitDecomposition(auth, input);
    expect(second.merged.length).toBe(1);
    expect(second.merged[0].versionNumber).toBe(first.merged[0].versionNumber);
    const stillAfter = await getNote(auth, target.id);
    expect(stillAfter?.version).toBe(2);
  });

  it("merge into a foreign-workspace card is rejected", async () => {
    const auth = ownerAuth(ws.userId, ws.workspaceId);
    const foreignAuth = ownerAuth(otherWs.userId, otherWs.workspaceId);
    const foreign = await createNote(foreignAuth, {
      idempotencyKey: `dml-foreign-${Date.now()}`,
      title: "Foreign card",
      content: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "not yours" }] }] },
      plainText: "not yours",
      kind: "zettel",
    });
    const analysis = analysisWith({ id: "cand-x", title: "Cross-workspace attempt", content: "should not land" });
    await expect(
      commitDecomposition(auth, { analysis, decisions: [{ candidateId: "cand-x", action: "merge", targetArtifactId: foreign.id }], idempotencyKey: `dml-x-${Date.now()}` }),
    ).rejects.toThrow("no longer exists");
  });

  it("link creates the card plus an explicit related edge, idempotent on retry", async () => {
    const auth = ownerAuth(ws.userId, ws.workspaceId);
    const target = await createNote(auth, {
      idempotencyKey: `dml-link-t-${Date.now()}`,
      title: "Link target card",
      content: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "anchor" }] }] },
      plainText: "anchor",
      kind: "zettel",
    });
    const analysis = analysisWith({ id: "cand-link", title: "Linked new card", content: "stands alone but related" });
    const input = { analysis, decisions: [{ candidateId: "cand-link", action: "link" as const, targetArtifactId: target.id }], idempotencyKey: `dml-linkb-${Date.now()}` };
    const first = await commitDecomposition(auth, input);
    expect(first.created.length).toBe(1);
    expect(first.linked.length).toBe(1);
    const edges = await handle!.db
      .select()
      .from(artifactLinks)
      .where(and(eq(artifactLinks.artifactId, first.created[0].id), eq(artifactLinks.linkType, "related")));
    expect(edges.length).toBe(1);
    expect(edges[0].targetId).toBe(target.id);
    // Retry: createNote's receipt key returns the same card, the edge insert conflicts away.
    const second = await commitDecomposition(auth, input);
    expect(second.created[0].id).toBe(first.created[0].id);
    const edgesAfter = await handle!.db
      .select()
      .from(artifactLinks)
      .where(and(eq(artifactLinks.artifactId, first.created[0].id), eq(artifactLinks.linkType, "related")));
    expect(edgesAfter.length).toBe(1);
  });


  it("created zettels join the sitting created_here, once per retry", async () => {
    const auth = ownerAuth(ws.userId, ws.workspaceId);
    const sitting = await createSitting(auth, { topic: "join" });
    const analysis = analysisWith({ id: "cand-join", title: "Join me", content: "a card born in the sitting" });
    const input = { analysis, decisions: [{ candidateId: "cand-join", action: "create" as const }], idempotencyKey: `dsj-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, sittingId: sitting.id };
    const first = await commitDecomposition(auth, input);
    const second = await commitDecomposition(auth, input);
    expect(second.created[0].id).toBe(first.created[0].id);
    const cards = await listSittingCards(auth, sitting.id);
    expect(cards.length).toBe(1);
    expect(cards[0].artifactId).toBe(first.created[0].id);
    expect(cards[0].roleInSitting).toBe("created_here");
  });

  it("checklist accept creates the task in a transaction, replay-stable on retry", async () => {
    const auth = ownerAuth(ws.userId, ws.workspaceId);
    const analysis = analysisWith({ id: "cand-task", title: "Do the smoke thing", content: "step one, step two" });
    analysis.candidates[0]!.role = "checklist";
    const input = {
      analysis,
      decisions: [{ candidateId: "cand-task", action: "create" as const }],
      idempotencyKey: `dtask-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    };
    const first = await commitDecomposition(auth, input);
    expect(first.created).toHaveLength(1);
    expect(first.created[0]!.destination).toBe("task");

    // A UI retry with the same key must replay the receipt, not insert again
    // (and must not throw the rank-assignment transaction guard).
    const second = await commitDecomposition(auth, input);
    expect(second.created[0]!.id).toBe(first.created[0]!.id);

    const rows = await handle!.db
      .select({ id: tasks.id })
      .from(tasks)
      .where(and(eq(tasks.workspaceId, ws.workspaceId), eq(tasks.title, "Do the smoke thing")));
    expect(rows).toHaveLength(1);
  });
});
