import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { outboxEvents } from "@/domains/audit/schema";
import { captures } from "@/domains/capture/schema";
import { documents, files, documentExtractions, zettelProposals } from "@/domains/knowledge/schema";
import { makeTestDb, seedWorkspace, ownerAuth } from "../helpers/test-workspace";

/*
 * "Save to library": a text capture becomes a library document through the
 * one intake path (Product Spec, Capture: the inbox owns the triggers that
 * create zettels from captured knowledge). The lineage edge lands in intake's
 * transaction, extraction reads the markdown bytes without a provider, and
 * the existing zettel pipeline proposes from the extracted text.
 */

const handle = makeTestDb();
const suite = handle ? describe : describe.skip;
const holder: { db: ReturnType<typeof drizzle> | undefined } = { db: undefined };
vi.mock("@/lib/db", () => ({ get db() { return holder.db; } }));
vi.mock("@/lib/db-transaction", () => ({
  get withTransaction() {
    return (fn: Parameters<typeof import("@/lib/db-transaction").withTransaction>[0]) =>
      (holder.db!.transaction as typeof import("@/lib/db-transaction").withTransaction)(fn);
  },
}));

import { convertCaptureToDocument, ConflictError, StaleWriteError } from "@/domains/capture/commands";
import { extractDocument } from "@/domains/knowledge/extraction";
import { proposeZettels } from "@/domains/knowledge/zettels";

const BODY = "Atomic notes compound.\n\nA zettel carries one idea, verbatim evidence, and links to its neighbours. Writing them daily turns reading into thinking.";

beforeAll(() => {
  holder.db = handle?.db;
  vi.stubEnv("OPENROUTER_API_KEY", "");
  vi.stubEnv("GEMINI_API_KEY", "");
  vi.stubEnv("OPENAI_API_KEY", "");
});
afterAll(async () => { vi.unstubAllEnvs(); await handle?.client.end(); });

async function addTextCapture(db: NonNullable<typeof holder.db>, ws: string, userId: string, text: string | null) {
  const [row] = await db
    .insert(captures)
    .values({ workspaceId: ws, kind: "text", rawPayload: text ? { text } : {}, text, createdBy: userId, updatedBy: userId })
    .returning();
  return row;
}

suite("convertCaptureToDocument", () => {
  it("files the capture text as a document and marks the capture converted in one commit", async () => {
    const { userId, workspaceId } = await seedWorkspace(holder.db!, `c2d-basic-${Date.now()}`);
    const auth = ownerAuth(userId, workspaceId);
    const capture = await addTextCapture(holder.db!, workspaceId, userId, BODY);

    const result = await convertCaptureToDocument(auth, { captureId: capture.id, expectedVersion: capture.version });
    expect(result.documentId).toBeTruthy();

    const [doc] = await holder.db!.select().from(documents).where(eq(documents.id, result.documentId!));
    expect(doc.workspaceId).toBe(workspaceId);
    expect(doc.title).toBe("Atomic notes compound.");
    expect(doc.fileId).toBeTruthy();

    const [file] = await holder.db!.select().from(files).where(eq(files.id, doc.fileId!));
    expect(file.origin).toBe("capture");
    expect(file.status).toBe("uploaded");

    const [updated] = await holder.db!.select().from(captures).where(eq(captures.id, capture.id));
    expect(updated.processingState).toBe("converted");
    expect(updated.convertedType).toBe("document");
    expect(updated.convertedId).toBe(result.documentId);

    const [queued] = await holder.db!
      .select()
      .from(outboxEvents)
      .where(and(eq(outboxEvents.workspaceId, workspaceId), eq(outboxEvents.topic, "document.extraction_requested")));
    expect(queued).toBeTruthy();
  });

  it("feeds the existing pipeline: extraction succeeds from the bytes, zettel proposals quote it verbatim", async () => {
    const { userId, workspaceId } = await seedWorkspace(holder.db!, `c2d-pipe-${Date.now()}`);
    const auth = ownerAuth(userId, workspaceId);
    const capture = await addTextCapture(holder.db!, workspaceId, userId, BODY);

    const { documentId } = await convertCaptureToDocument(auth, { captureId: capture.id, expectedVersion: capture.version });
    const extraction = await extractDocument(auth, { documentId: documentId! });
    expect(extraction.ok).toBe(true);

    const created = await proposeZettels(auth, {
      documentId: documentId!,
      extractor: {
        name: "test-extractor",
        extract: async () => [
          { title: "One idea per card", claim: "A zettel holds exactly one idea.", quote: "A zettel carries one idea, verbatim evidence" },
          { title: "Invented", claim: "Not in the text.", quote: "this passage was never written down anywhere" },
        ],
      },
    });
    expect(created).toHaveLength(1); // the invented quote is dropped
    expect(created[0].quote).toBe("A zettel carries one idea, verbatim evidence");
    const [extractionRow] = await holder.db!
      .select()
      .from(documentExtractions)
      .where(and(eq(documentExtractions.documentId, documentId!), eq(documentExtractions.status, "succeeded")));
    expect(created[0].extractionId).toBe(extractionRow.id);
    const [proposal] = await holder.db!.select().from(zettelProposals).where(eq(zettelProposals.documentId, documentId!));
    expect(proposal.status).toBe("proposed");
  });

  it("refuses a second conversion and a stale version", async () => {
    const { userId, workspaceId } = await seedWorkspace(holder.db!, `c2d-guards-${Date.now()}`);
    const auth = ownerAuth(userId, workspaceId);
    const capture = await addTextCapture(holder.db!, workspaceId, userId, BODY);

    await expect(convertCaptureToDocument(auth, { captureId: capture.id, expectedVersion: capture.version + 1 }))
      .rejects.toBeInstanceOf(StaleWriteError);
    await convertCaptureToDocument(auth, { captureId: capture.id, expectedVersion: capture.version });
    await expect(convertCaptureToDocument(auth, { captureId: capture.id, expectedVersion: capture.version }))
      .rejects.toBeInstanceOf(ConflictError);
  });

  it("refuses a capture with no text and another workspace's capture", async () => {
    const { userId, workspaceId } = await seedWorkspace(holder.db!, `c2d-empty-${Date.now()}`);
    const auth = ownerAuth(userId, workspaceId);
    const empty = await addTextCapture(holder.db!, workspaceId, userId, null);
    await expect(convertCaptureToDocument(auth, { captureId: empty.id, expectedVersion: empty.version }))
      .rejects.toBeInstanceOf(ConflictError);

    const other = await seedWorkspace(holder.db!, `c2d-other-${Date.now()}`);
    const foreign = await addTextCapture(holder.db!, other.workspaceId, other.userId, BODY);
    await expect(convertCaptureToDocument(auth, { captureId: foreign.id, expectedVersion: foreign.version }))
      .rejects.toBeInstanceOf(StaleWriteError);
  });
});
