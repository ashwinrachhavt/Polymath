import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { outboxEvents } from "@/domains/audit/schema";
import { makeTestDb, ownerAuth, seedWorkspace } from "../helpers/test-workspace";

/*
 * `note.created` used to have no consumer: the dispatcher released its rows
 * every 60 seconds forever, and every task create, subtask and imported issue
 * enqueued one. These pin what the handler must guarantee against real
 * Postgres - the topic is registered (so no row is released unread), a
 * delivered event is consumed, and a locked note is parked rather than failed.
 *
 * The embed pass is stubbed at the module boundary the handler calls: the
 * provider is a metered network dependency, and what is under test is the
 * handler's contract with the queue. The artifact and version behaviour
 * underneath belongs to embedding's own suite.
 */

const { embedArtifact } = vi.hoisted(() => ({
  embedArtifact: vi.fn<(auth: unknown, input: { artifactId: string }) => Promise<unknown>>(),
}));
vi.mock("@/domains/knowledge/embedding", () => ({
  embedArtifact,
  ARTIFACT_EMBEDDING_OWNER_TYPE: "artifact",
}));

const handle = makeTestDb();
const suite = handle ? describe : describe.skip;

let outbox: typeof import("@/domains/audit/outbox");
let handlers: typeof import("@/domains/audit/outbox-handlers");
let notes: typeof import("@/domains/knowledge/notes");
let dbTransaction: typeof import("@/lib/db-transaction");

beforeAll(async () => {
  if (!handle) return;
  outbox = await import("@/domains/audit/outbox");
  handlers = await import("@/domains/audit/outbox-handlers");
  notes = await import("@/domains/knowledge/notes");
  dbTransaction = await import("@/lib/db-transaction");
  embedArtifact.mockResolvedValue({ status: "skipped", reason: "no_text" });
});

afterAll(async () => {
  await handle?.client.end();
});

/** A real workspace and a real note, so its `note.created` event is a real row. */
async function seedNote(label: string) {
  const { userId, workspaceId } = await seedWorkspace(handle!.db, `note-event-${label}-${Date.now()}`);
  const auth = ownerAuth(userId, workspaceId);
  const note = await dbTransaction.withTransaction((tx) =>
    notes.createNoteInTx(tx, auth, { title: `A note for ${label}` }),
  );
  const rows = await handle!.db
    .select()
    .from(outboxEvents)
    .where(and(eq(outboxEvents.workspaceId, workspaceId), eq(outboxEvents.topic, "note.created")));
  const event = rows.find((row) => (row.payload as { artifactId?: string } | null)?.artifactId === note.id);
  return { auth, workspaceId, note, event: event! };
}

/** The row after the dispatcher has run, as the handler's real call path leaves it. */
async function dispatchWorkspace(workspaceId: string) {
  // The dispatcher is workspace-blind and claims whatever is due, including
  // other suites' events, so run it until this workspace's note.created row
  // has left `pending` rather than asserting on a single batch's counts.
  for (let run = 0; run < 20; run += 1) {
    const rows = await handle!.db
      .select()
      .from(outboxEvents)
      .where(and(eq(outboxEvents.workspaceId, workspaceId), eq(outboxEvents.topic, "note.created")));
    if (rows.every((row) => row.status !== "pending")) return rows;
    await outbox.dispatchPendingOutbox(handle!.client, handlers.outboxHandlers(), {
      workerId: `note-event-${crypto.randomUUID()}`,
    });
  }
  return handle!.db
    .select()
    .from(outboxEvents)
    .where(and(eq(outboxEvents.workspaceId, workspaceId), eq(outboxEvents.topic, "note.created")));
}

suite("note.created consumer", () => {
  it("is registered, so its rows are dispatched instead of released unread", () => {
    expect(handlers.outboxHandlers()["note.created"]).toBeTypeOf("function");
  });

  it("embeds the note the event names and marks the row dispatched", async () => {
    if (!handle) return;
    const { auth, workspaceId, note, event } = await seedNote("consumed");
    expect(event.status).toBe("pending");

    const [row] = await dispatchWorkspace(workspaceId);

    expect(row.status).toBe("dispatched");
    expect(embedArtifact).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: auth.workspaceId }),
      { artifactId: note.id },
    );
  });

  it("parks instead of failing when another pass holds the note", async () => {
    if (!handle) return;
    const { event } = await seedNote("busy");
    embedArtifact.mockResolvedValueOnce({ status: "skipped", reason: "busy" });

    // Called directly: a parked row stays pending by design, so waiting for it
    // to leave the queue would never return.
    const handler = handlers.outboxHandlers()["note.created"];
    await expect(
      handler({ ...event, leaseToken: crypto.randomUUID() }),
    ).rejects.toBeInstanceOf(outbox.OutboxParkError);

    // The row itself is untouched: still pending, attempts unspent, so the
    // work is owed rather than lost to the dead-letter ceiling.
    const [row] = await handle.db.select().from(outboxEvents).where(eq(outboxEvents.id, event.id));
    expect(row).toMatchObject({ status: "pending", attempts: 0 });
  });

  it("consumes an event whose note is gone rather than retrying it forever", async () => {
    if (!handle) return;
    const { workspaceId, note } = await seedNote("gone");
    // The note is deleted after its event was written. Nothing can ever embed
    // it, so consuming the event is the correct outcome, not a failure.
    await handle.db
      .update(outboxEvents)
      .set({ payload: { artifactId: crypto.randomUUID() } })
      .where(and(eq(outboxEvents.workspaceId, workspaceId), eq(outboxEvents.topic, "note.created")));
    void note;

    const [row] = await dispatchWorkspace(workspaceId);
    expect(row.status).toBe("dispatched");
  });
});
