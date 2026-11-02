import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { blobObjects, outboxEvents } from "@/domains/audit/schema";
import { artifacts, documentExtractions, documents, embeddings, files } from "@/domains/knowledge/schema";
import type { EmbeddingProvider } from "@/integrations/embeddings/provider";
import { makeTestDb, ownerAuth, seedWorkspace } from "../helpers/test-workspace";

/*
 * The self-healing index, end to end on real Postgres with a fake provider:
 * a note whose commit-path embed failed is swept into a durable retry order,
 * the dispatcher re-runs the same embedArtifact the commit path uses, and the
 * pending/failed populations retrieval.ts counts honestly actually drain. A
 * second sweep over a healed (or still-in-flight) workspace no-ops. The
 * same-model guard holds at every layer: vectors from a retired model never
 * read as coverage - in the sweep, in the embed's own covered-check, or in
 * search. Document extractions ride the same driver.
 *
 * Embeddings come from a local fake; Postgres is real.
 */

const handle = makeTestDb();
const suite = handle ? describe : describe.skip;
let db: NonNullable<typeof handle>["db"];
let client: NonNullable<typeof handle>["client"];
let outbox: typeof import("@/domains/audit/outbox");
let driver: typeof import("@/domains/knowledge/embedding-retry");
let knowledge: typeof import("@/domains/knowledge/embedding");
let retrieval: typeof import("@/domains/knowledge/retrieval");
let notes: typeof import("@/domains/knowledge/notes");

function vec(dims: number[]): number[] {
  const v = new Array(1536).fill(0);
  for (const d of dims) v[d] = 1;
  return v;
}
/** Maps a text to a concept direction, so "meaning" is controllable. */
const conceptProvider = (model: string, concepts: Record<string, number[]>): EmbeddingProvider => ({
  model,
  embed: async (values) =>
    values.map((t) => {
      const hit = Object.entries(concepts).find(([k]) => t.toLowerCase().includes(k));
      return hit ? hit[1] : vec([900]);
    }),
});
const failingProvider = (model: string): EmbeddingProvider => ({
  model,
  embed: async () => {
    throw new Error("provider down");
  },
});

beforeAll(async () => {
  if (!handle) return;
  ({ db, client } = handle);
  outbox = await import("@/domains/audit/outbox");
  driver = await import("@/domains/knowledge/embedding-retry");
  knowledge = await import("@/domains/knowledge/embedding");
  retrieval = await import("@/domains/knowledge/retrieval");
  notes = await import("@/domains/knowledge/notes");
  // The commit path's own best-effort embed must see NO provider, so the
  // failed state under test is the real unconfigured one, not a live key
  // leaked from the developer's shell (which would also make a paid call).
  vi.stubEnv("OPENROUTER_API_KEY", "");
  vi.stubEnv("OPENAI_API_KEY", "");
  vi.stubEnv("EMBEDDING_PROVIDER", "");
});
afterAll(async () => {
  vi.unstubAllEnvs();
  await client.end();
});
beforeEach(async () => {
  await db.execute(sql`delete from outbox_events`);
});

type Auth = Awaited<ReturnType<typeof workspace>>;
const workspace = async () => {
  const seeded = await seedWorkspace(db, `er-${crypto.randomUUID()}`);
  return ownerAuth(seeded.userId, seeded.workspaceId);
};

async function writeNote(auth: Auth, title: string, text: string) {
  const note = await notes.createNote(auth, { title, kind: "note" });
  await notes.commitNoteSnapshot(auth, {
    artifactId: note.id,
    expectedVersion: 1,
    content: { format: "markdown", text },
    plainText: text,
  });
  return note;
}

async function seedExtraction(auth: Auth, text: string, title: string) {
  const [blob] = await db
    .insert(blobObjects)
    .values({
      workspaceId: auth.workspaceId,
      storageKey: `private/${crypto.randomUUID()}`,
      contentHash: crypto.randomUUID(),
      sizeBytes: 4,
      mimeType: "application/pdf",
    })
    .returning();
  const [file] = await db
    .insert(files)
    .values({ workspaceId: auth.workspaceId, blobId: blob.id, filename: `${title}.pdf` })
    .returning();
  const [doc] = await db
    .insert(documents)
    .values({ workspaceId: auth.workspaceId, title, fileId: file.id, mimeType: "application/pdf" })
    .returning();
  const [extraction] = await db
    .insert(documentExtractions)
    .values({
      workspaceId: auth.workspaceId,
      documentId: doc.id,
      contentHash: crypto.randomUUID(),
      status: "succeeded",
      text,
      extractor: "fixture@1",
      spans: [{ page: 1, start: 0, end: text.length }],
    })
    .returning();
  await db.update(documents).set({ activeExtractionId: extraction.id }).where(eq(documents.id, doc.id));
  return { doc, extraction };
}

const orders = (workspaceId: string) =>
  db
    .select()
    .from(outboxEvents)
    .where(and(eq(outboxEvents.workspaceId, workspaceId), eq(outboxEvents.topic, driver.EMBEDDING_RETRY_TOPIC)));
const orderOwners = async (workspaceId: string) =>
  (await orders(workspaceId)).map((row) => (row.payload as { ownerId?: string }).ownerId);
/** A failed attempt parks the row behind backoff; a test redelivery makes it due again. */
const makeDue = async (workspaceId: string) => {
  await db
    .update(outboxEvents)
    .set({ availableAt: new Date(Date.now() - 1000) })
    .where(eq(outboxEvents.workspaceId, workspaceId));
};
const dispatch = (auth: Auth, provider: EmbeddingProvider) =>
  outbox.dispatchPendingOutbox(
    client,
    {
      [driver.EMBEDDING_RETRY_TOPIC]: driver.embeddingRetryRequestedHandler(
        async (workspaceId) => (workspaceId === auth.workspaceId ? auth : null),
        { provider },
      ),
    },
    { workerId: "w1" },
  );

suite("embedding retry driver (real Postgres)", () => {
  it("a note seeded with embed_error sweeps into an order, dispatches into vectors, drops the counts, and a second sweep no-ops", async () => {
    const auth = await workspace();
    const note = await writeNote(auth, "Sourdough starter", "Flour, water and patience make the fermentation work.");

    // The commit's own embed saw no provider: the failure is recorded and the
    // fleet counter names it failed - the exact population nothing re-drove.
    expect(await retrieval.countMeaningUncoveredByState(auth, {})).toEqual({ pending: 0, failed: 1 });

    const sweep = await driver.sweepUncoveredEmbeddings(auth, {
      provider: conceptProvider("fake@1", { fermentation: vec([1]) }),
    });
    expect(sweep).toMatchObject({ scanned: 1, enqueued: 1, model: "fake@1" });
    const [order] = await orders(auth.workspaceId);
    expect(order).toMatchObject({ topic: "embedding.retry_requested", status: "pending" });
    expect(order.payload).toMatchObject({ ownerType: "artifact", ownerId: note.id });

    const pass = await dispatch(auth, conceptProvider("fake@1", { fermentation: vec([1]) }));
    // The batch also acks the audit-only note.created rows the notes module
    // emits; what matters here is that my topic neither failed nor parked.
    expect(pass).toMatchObject({ failed: 0, parked: 0 });
    const [delivered] = await orders(auth.workspaceId);
    expect(delivered.status).toBe("dispatched");

    // The embedding exists, the error is cleared, and the meaning leg finds
    // the note by concept - the guarantee, not just the mechanics.
    const rows = await db.select().from(embeddings).where(eq(embeddings.ownerId, note.id));
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]).toMatchObject({ ownerType: "artifact", model: "fake@1" });
    const [artifact] = await db
      .select({ embedError: artifacts.embedError })
      .from(artifacts)
      .where(eq(artifacts.id, note.id));
    expect(artifact.embedError).toBeNull();
    expect(await retrieval.countMeaningUncoveredByState(auth, {})).toEqual({ pending: 0, failed: 0 });
    const found = await retrieval.searchKnowledge(auth, {
      query: "fermentation",
      mode: "meaning",
      provider: conceptProvider("fake@1", { fermentation: vec([1]) }),
    });
    expect(found.hits.map((h) => h.id)).toContain(note.id);

    // Second run no-ops: nothing is uncovered, so nothing is swept.
    const rerun = await driver.sweepUncoveredEmbeddings(auth, {
      provider: conceptProvider("fake@1", { fermentation: vec([1]) }),
    });
    expect(rerun).toMatchObject({ scanned: 0, enqueued: 0 });
    expect(await orders(auth.workspaceId)).toHaveLength(1); // no new orders
  });

  it("a sweep over work still in flight dedupes instead of doubling the queue", async () => {
    const auth = await workspace();
    await writeNote(auth, "One", "Text about fermentation.");
    await writeNote(auth, "Two", "Text about brewing.");
    const provider = conceptProvider("fake@1", {});
    expect(await driver.sweepUncoveredEmbeddings(auth, { provider })).toMatchObject({ scanned: 2, enqueued: 2 });
    // The orders are still pending (undispatched), and the owners are still
    // uncovered - the second sweep must find them covered BY AN ORDER, not
    // cut twins.
    expect(await driver.sweepUncoveredEmbeddings(auth, { provider })).toMatchObject({ scanned: 2, enqueued: 0 });
    expect(await orders(auth.workspaceId)).toHaveLength(2);
  });

  it("the same-model guard: vectors from a retired model never read as coverage", async () => {
    const auth = await workspace();
    const note = await writeNote(auth, "Guarded", "Text about fermentation.");
    const oldModel = conceptProvider("fake@1", { fermentation: vec([1]) });
    expect(await knowledge.embedArtifact(auth, { artifactId: note.id, provider: oldModel })).toEqual({
      status: "succeeded",
      chunks: 1,
    });
    expect(await retrieval.countMeaningUncovered(auth, {})).toBe(0);

    // A model switch: the fake@1 vectors are unreadable to fake@2 search, so
    // the sweep must re-drive the note and the re-embed must pay the provider
    // again instead of joining the old-model index.
    const newModel = conceptProvider("fake@2", { fermentation: vec([1]) });
    expect(await driver.sweepUncoveredEmbeddings(auth, { provider: newModel })).toMatchObject({
      scanned: 1,
      enqueued: 1,
    });
    expect(await dispatch(auth, newModel)).toMatchObject({ failed: 0, parked: 0 });
    const [reordered] = await orders(auth.workspaceId);
    expect(reordered.status).toBe("dispatched");

    const rows = await db.select().from(embeddings).where(eq(embeddings.ownerId, note.id));
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(row.model).toBe("fake@2");
    expect(await retrieval.countMeaningUncovered(auth, {})).toBe(0);
    expect(await driver.sweepUncoveredEmbeddings(auth, { provider: newModel })).toMatchObject({
      scanned: 0,
      enqueued: 0,
    });
  });

  it("the batch bound: a bounded pass heals the freshest first and leaves the rest for the next pass", async () => {
    const auth = await workspace();
    const old = await writeNote(auth, "Oldest", "Text about fermentation that waits.");
    await db
      .update(artifacts)
      .set({ updatedAt: new Date(Date.now() - 60_000) })
      .where(eq(artifacts.id, old.id));
    const freshA = await writeNote(auth, "Fresh A", "Text about brewing.");
    const freshB = await writeNote(auth, "Fresh B", "Text about calendaring.");

    const sweep = await driver.sweepUncoveredEmbeddings(auth, {
      provider: conceptProvider("fake@1", {}),
      limit: 2,
    });
    expect(sweep).toMatchObject({ scanned: 2, enqueued: 2 });
    const owners = await orderOwners(auth.workspaceId);
    expect(owners).toHaveLength(2);
    expect(owners).toContain(freshA.id);
    expect(owners).toContain(freshB.id);
    expect(owners).not.toContain(old.id);
    // The old note was not abandoned, only deferred: its recorded failure is
    // untouched, and the next pass takes exactly it.
    const [stale] = await db
      .select({ embedError: artifacts.embedError })
      .from(artifacts)
      .where(eq(artifacts.id, old.id));
    expect(stale.embedError).toContain("No embedding provider configured");
    await makeDue(auth.workspaceId);
    await dispatch(auth, conceptProvider("fake@1", {}));
    expect(await driver.sweepUncoveredEmbeddings(auth, { provider: conceptProvider("fake@1", {}) })).toMatchObject({
      scanned: 1,
      enqueued: 1,
    });
    expect(await orderOwners(auth.workspaceId)).toContain(old.id);
  });

  it("a failing provider pass cuts its own retry order, and the queue then heals it", async () => {
    const auth = await workspace();
    const note = await writeNote(auth, "Outage", "Text about fermentation.");
    // The commit path failed with no provider configured: recorded, but no
    // order - retrying cannot set a key.
    expect(await orders(auth.workspaceId)).toHaveLength(0);
    const unconfigured = await knowledge.embedArtifact(auth, { artifactId: note.id });
    expect(unconfigured.status).toBe("failed");
    expect(await orders(auth.workspaceId)).toHaveLength(0);

    // A transient provider failure is different: the failure is recorded AND
    // an order commits with it, so the outage ends in a re-drive.
    const failing = await knowledge.embedArtifact(auth, {
      artifactId: note.id,
      provider: failingProvider("fake@1"),
    });
    expect(failing).toMatchObject({ status: "failed" });
    const [order] = await orders(auth.workspaceId);
    expect(order).toMatchObject({ topic: "embedding.retry_requested", status: "pending" });
    expect(order.dispatchKey).toContain("fake@1");

    // The queue delivers: a working provider heals what the outage broke.
    await makeDue(auth.workspaceId);
    const working = conceptProvider("fake@1", { fermentation: vec([1]) });
    expect(await dispatch(auth, working)).toMatchObject({ failed: 0, parked: 0 });
    const [healed] = await orders(auth.workspaceId);
    expect(healed.status).toBe("dispatched");
    const rows = await db.select().from(embeddings).where(eq(embeddings.ownerId, note.id));
    expect(rows.length).toBeGreaterThan(0);
    const [artifact] = await db
      .select({ embedError: artifacts.embedError })
      .from(artifacts)
      .where(eq(artifacts.id, note.id));
    expect(artifact.embedError).toBeNull();
  });

  it("the sweep drives the pending population too, not just rows with embed_error", async () => {
    const auth = await workspace();
    const note = await writeNote(auth, "Pending-shaped", "Text about fermentation.");
    // Strip the recorded failure: text present, no vectors, no error - the
    // exact shape of a pass skipped mid-race (the "edited" outcome).
    await db.update(artifacts).set({ embedError: null }).where(eq(artifacts.id, note.id));
    expect(await retrieval.countMeaningUncoveredByState(auth, {})).toEqual({ pending: 1, failed: 0 });

    const sweep = await driver.sweepUncoveredEmbeddings(auth, { provider: conceptProvider("fake@1", {}) });
    expect(sweep).toMatchObject({ scanned: 1, enqueued: 1 });
    await makeDue(auth.workspaceId);
    expect(await dispatch(auth, conceptProvider("fake@1", {}))).toMatchObject({ failed: 0, parked: 0 });
    const rows = await db.select().from(embeddings).where(eq(embeddings.ownerId, note.id));
    expect(rows.length).toBeGreaterThan(0);
  });

  it("uncovered extractions ride the same driver, and only the current extraction is ever re-driven", async () => {
    const auth = await workspace();
    const text =
      "The tenant pays monthly rent of twelve hundred dollars. The landlord keeps the security deposit. ".repeat(10);
    const { extraction } = await seedExtraction(auth, text, "lease");
    // A superseded extraction on the same document: search never reads it
    // (versions.ts owns "current"), so the sweep must not spend a pass on it.
    const [superseded] = await db
      .insert(documentExtractions)
      .values({
        workspaceId: auth.workspaceId,
        documentId: extraction.documentId,
        contentHash: crypto.randomUUID(),
        status: "succeeded",
        text,
        extractor: "fixture@1",
      })
      .returning();

    const sweep = await driver.sweepUncoveredEmbeddings(auth, { provider: conceptProvider("fake@1", {}) });
    expect(sweep).toMatchObject({ scanned: 1, enqueued: 1 });
    const owners = await orderOwners(auth.workspaceId);
    expect(owners).toEqual([extraction.id]);
    expect(owners).not.toContain(superseded.id);

    const provider = conceptProvider("fake@1", { tenant: vec([1]) });
    await makeDue(auth.workspaceId);
    expect(await dispatch(auth, provider)).toMatchObject({ failed: 0, parked: 0 });
    const rows = await db.select().from(embeddings).where(eq(embeddings.ownerId, extraction.id));
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]).toMatchObject({ ownerType: "document_extraction", model: "fake@1" });
    const [row] = await db
      .select({ embedError: documentExtractions.embedError })
      .from(documentExtractions)
      .where(eq(documentExtractions.id, extraction.id));
    expect(row.embedError).toBeNull();
    expect(await driver.sweepUncoveredEmbeddings(auth, { provider })).toMatchObject({ scanned: 0, enqueued: 0 });
  });

  it("an archived document's extraction is nobody to re-drive", async () => {
    const auth = await workspace();
    const { doc, extraction } = await seedExtraction(auth, "Text about fermentation.", "archived lease");
    await db.update(documents).set({ archivedAt: new Date() }).where(eq(documents.id, doc.id));
    expect(await driver.sweepUncoveredEmbeddings(auth, { provider: conceptProvider("fake@1", {}) })).toMatchObject({
      scanned: 0,
      enqueued: 0,
    });
    expect(extraction.id).toBeTruthy();
  });

  it("the handler parks when another pass holds the advisory lock, spending no attempt", async () => {
    const auth = await workspace();
    const note = await writeNote(auth, "Busy", "Text about fermentation.");
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let calls = 0;
    const slow: EmbeddingProvider = {
      model: "fake@1",
      embed: async (values) => {
        calls++;
        await gate;
        return values.map(() => vec([1]));
      },
    };
    const first = knowledge.embedArtifact(auth, { artifactId: note.id, provider: slow });
    await vi.waitFor(() => expect(calls).toBe(1)); // the pass holds the lock, mid-call

    expect(await driver.sweepUncoveredEmbeddings(auth, { provider: conceptProvider("fake@1", {}) })).toMatchObject({
      scanned: 1,
      enqueued: 1,
    });
    const pass = await dispatch(auth, slow);
    expect(pass).toMatchObject({ parked: 1, failed: 0 });
    const [order] = await orders(auth.workspaceId);
    expect(order.attempts).toBe(0); // parking never spends an attempt

    release();
    expect(await first).toEqual({ status: "succeeded", chunks: 1 });
  });

  it("a malformed payload fails the attempt loudly instead of completing as a silent no-op", async () => {
    const auth = await workspace();
    // Hand-written row in a shape the producer never emits ("note" was the
    // original handoff's ownerType and is not a coverage unit).
    await db.insert(outboxEvents).values({
      workspaceId: auth.workspaceId,
      topic: driver.EMBEDDING_RETRY_TOPIC,
      payload: { ownerType: "note", ownerId: crypto.randomUUID() },
    });
    const pass = await dispatch(auth, conceptProvider("fake@1", {}));
    expect(pass).toMatchObject({ failed: 1, dispatched: 0 });
    const [order] = await orders(auth.workspaceId);
    expect(order.lastError).toContain("malformed payload");
    expect(order.status).toBe("pending"); // attempt 1 of 5: backed off, not dead
    expect(order.attempts).toBe(1);
  });

  it("an order for another workspace's note completes without touching it", async () => {
    const mine = await workspace();
    const other = await workspace();
    const foreign = await writeNote(other, "Foreign", "Text that is not mine.");
    await db.insert(outboxEvents).values({
      workspaceId: mine.workspaceId,
      topic: driver.EMBEDDING_RETRY_TOPIC,
      payload: { ownerType: "artifact", ownerId: foreign.id },
    });
    expect(await dispatch(mine, conceptProvider("fake@1", {}))).toMatchObject({ failed: 0, parked: 0 });
    const [crossed] = await orders(mine.workspaceId);
    expect(crossed.status).toBe("dispatched");
    const rows = await db.select().from(embeddings).where(eq(embeddings.ownerId, foreign.id));
    expect(rows).toHaveLength(0); // embedArtifact scoped to the caller's workspace
  });

  it("a note with nothing to index completes its order as a real outcome, not a failure", async () => {
    const auth = await workspace();
    await writeNote(auth, "Empty", "");
    const sweep = await driver.sweepUncoveredEmbeddings(auth, { provider: conceptProvider("fake@1", {}) });
    expect(sweep).toMatchObject({ scanned: 0, enqueued: 0 }); // empty text is never uncovered work
    // A hand-cut order for a missing owner still completes honestly.
    await db.insert(outboxEvents).values({
      workspaceId: auth.workspaceId,
      topic: driver.EMBEDDING_RETRY_TOPIC,
      payload: { ownerType: "artifact", ownerId: crypto.randomUUID() },
    });
    expect(await dispatch(auth, conceptProvider("fake@1", {}))).toMatchObject({ failed: 0, parked: 0 });
    const [orphan] = await orders(auth.workspaceId);
    expect(orphan.status).toBe("dispatched");
  });

  it("a sweep with no provider configured is an error, not a silent empty pass", async () => {
    const auth = await workspace();
    await writeNote(auth, "Unconfigured", "Text about fermentation.");
    await expect(driver.sweepUncoveredEmbeddings(auth, {})).rejects.toThrow();
    expect(await orders(auth.workspaceId)).toHaveLength(0);
  });
});
