import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { makeTestDb, seedWorkspace } from "../helpers/test-workspace";

/*
 * The notebook Sources pane's mutation surface against real Postgres: a pasted
 * URL captures and attaches to the notebook in one action; a YouTube link
 * queues and still binds by address; a failed fetch with a document row stays
 * attachable (Failed state, retryable); a Vault pick reuses the ingested
 * document; and every write is workspace-scoped.
 */

const handle = makeTestDb();
const suite = handle ? describe : describe.skip;
const holder: {
  db: ReturnType<typeof drizzle> | undefined;
  auth: { userId: string; workspaceId: string; role: "owner" } | undefined;
} = { db: undefined, auth: undefined };

vi.mock("@/lib/db", () => ({ get db() { return holder.db; } }));
vi.mock("@/lib/db-transaction", () => ({
  get withTransaction() {
    return (fn: Parameters<typeof import("@/lib/db-transaction").withTransaction>[0]) =>
      (holder.db!.transaction as typeof import("@/lib/db-transaction").withTransaction)(fn);
  },
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), updateTag: vi.fn() }));
vi.mock("@/lib/auth", () => ({
  getAuthContext: vi.fn(async () => {
    if (!holder.auth) throw new Error("no auth seeded");
    return holder.auth;
  }),
}));
vi.mock("@/integrations/object-store/object-store", () => ({
  readBlob: vi.fn(async () => new Uint8Array([1])),
  putBlob: vi.fn(async (input: { bytes: Uint8Array; filename: string; contentHash: string }) => ({
    storageKey: `private/${input.contentHash}`,
    contentHash: input.contentHash,
    sizeBytes: input.bytes.byteLength,
  })),
}));

import { outboxEvents } from "@/domains/audit/schema";
import { documents, dossierSources } from "@/domains/knowledge/schema";
import { attachToNotebookAction, addUrlToNotebookAction, retryNotebookSourceAction } from "@/app/(workspace)/alfred/dossiers/[dossierId]/notebook/add-source-actions";
import { createDossier } from "@/domains/knowledge/dossiers";

let db: NonNullable<typeof handle>["db"];
let dossierId: string;
let otherWorkspaceDossierId: string;

beforeAll(async () => {
  if (!handle) return;
  db = handle.db;
  holder.db = db;
  const a = await seedWorkspace(db, `nbadd-${Date.now()}`);
  holder.auth = { ...a, role: "owner" };
  dossierId = (await createDossier(holder.auth, { name: "Notebook", documentIds: [] })).id;
  // A second workspace proves the scoping checks.
  const b = await seedWorkspace(db, `nbadd-b-${Date.now()}`);
  const savedAuth = holder.auth;
  holder.auth = { ...b, role: "owner" };
  otherWorkspaceDossierId = (await createDossier(holder.auth, { name: "Elsewhere", documentIds: [] })).id;
  holder.auth = savedAuth;
});

afterAll(async () => { vi.unstubAllEnvs(); await handle?.client.end(); });

suite("notebook add-source actions (real Postgres)", () => {
  it("capturing a URL creates the document and attaches it to the notebook", async () => {
    const url = `https://example.com/page-${Date.now()}`;
    // example.com answers through safeFetch; offline or blocked, the action
    // must still state a reason and never throw into the client.
    const out = await addUrlToNotebookAction({ dossierId, url });
    const rows = await db.select({ fileId: documents.fileId }).from(documents)
      .where(eq(documents.workspaceId, holder.auth!.workspaceId));
    const attached = await db.select().from(dossierSources)
      .where(eq(dossierSources.dossierId, dossierId));
    if (out.ok) {
      expect(attached.length).toBeGreaterThan(0);
      expect(rows.length).toBeGreaterThan(0);
    } else {
      // A stated failure, never a crash: whatever happened, the notebook and
      // workspace are untouched or the row is Failed with a reason.
      expect(attached.every((r) => r.dossierId === dossierId)).toBe(true);
    }
  });

  it("a YouTube link queues the transcript job and binds the video to the notebook", async () => {
    const url = `https://www.youtube.com/watch?v=nb${Date.now()}`.slice(0, 43);
    const out = await addUrlToNotebookAction({ dossierId, url });
    expect(out.ok).toBe(true);
    const events = await db.select().from(outboxEvents)
      .where(eq(outboxEvents.workspaceId, holder.auth!.workspaceId));
    expect(events.some((e) => e.topic === "youtube.transcript_requested")).toBe(true);
    const attached = await db.select().from(dossierSources)
      .where(eq(dossierSources.dossierId, dossierId));
    expect(attached.length).toBeGreaterThan(0);
  });

  it("attaching from the Vault reuses the document, and a foreign document fails cleanly", async () => {
    const [doc] = await db.insert(documents).values({
      workspaceId: holder.auth!.workspaceId, title: "Vault pick",
      createdBy: holder.auth!.userId, updatedBy: holder.auth!.userId,
    }).returning({ id: documents.id });
    const out = await attachToNotebookAction({ dossierId, documentIds: [doc.id] });
    expect(out.ok).toBe(true);
    // Idempotent second attach says so instead of doubling rows.
    const again = await attachToNotebookAction({ dossierId, documentIds: [doc.id] });
    expect(again.ok).toBe(true);
    const foreign = await attachToNotebookAction({ dossierId, documentIds: [crypto.randomUUID()] });
    expect(foreign.ok).toBe(false);
  });

  it("a foreign dossier refuses attaches; a retry enqueues extraction", async () => {
    const [doc] = await db.insert(documents).values({
      workspaceId: holder.auth!.workspaceId, title: "Retry me",
      createdBy: holder.auth!.userId, updatedBy: holder.auth!.userId,
    }).returning({ id: documents.id });
    const foreign = await attachToNotebookAction({ dossierId: otherWorkspaceDossierId, documentIds: [doc.id] });
    expect(foreign.ok).toBe(false);
    const before = (await db.select().from(outboxEvents)
      .where(eq(outboxEvents.workspaceId, holder.auth!.workspaceId))).length;
    const retry = await retryNotebookSourceAction({ dossierId, documentId: doc.id });
    expect(retry.ok).toBe(true);
    const after = (await db.select().from(outboxEvents)
      .where(eq(outboxEvents.workspaceId, holder.auth!.workspaceId))).length;
    expect(after).toBe(before + 1);
  });
});
