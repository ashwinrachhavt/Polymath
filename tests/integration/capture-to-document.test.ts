import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { auditEvents, outboxEvents } from "@/domains/audit/schema";
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
vi.mock("@/lib/db", () => ({
  get db() {
    return holder.db;
  },
}));
vi.mock("@/lib/db-transaction", () => ({
  get withTransaction() {
    return (fn: Parameters<typeof import("@/lib/db-transaction").withTransaction>[0]) =>
      (holder.db!.transaction as typeof import("@/lib/db-transaction").withTransaction)(fn);
  },
}));

import { convertCaptureToDocument, createCapture, ConflictError, StaleWriteError } from "@/domains/capture/commands";
import { extractDocument } from "@/domains/knowledge/extraction";
import { searchDocuments } from "@/domains/knowledge/search";
import { proposeZettels } from "@/domains/knowledge/zettels";

const BODY =
  "Atomic notes compound.\n\nA zettel carries one idea, verbatim evidence, and links to its neighbours. Writing them daily turns reading into thinking.";

/** The extractor id the vision adapter records - openrouter-vision:${model}@hosted. */
const VISION_EXTRACTOR = "openrouter-vision:anthropic/claude-haiku-4.5@hosted";

beforeAll(() => {
  holder.db = handle?.db;
  vi.stubEnv("OPENROUTER_API_KEY", "");
  vi.stubEnv("GEMINI_API_KEY", "");
  vi.stubEnv("OPENAI_API_KEY", "");
});
afterAll(async () => {
  vi.unstubAllEnvs();
  await handle?.client.end();
});

async function addTextCapture(
  db: NonNullable<typeof holder.db>,
  ws: string,
  userId: string,
  text: string | null,
  title?: string,
) {
  const [row] = await db
    .insert(captures)
    .values({
      workspaceId: ws,
      kind: "text",
      captureMode: "authored",
      rawPayload: text ? { text } : {},
      text,
      title: title ?? null,
      createdBy: userId,
      updatedBy: userId,
    })
    .returning();
  return row;
}

/**
 * A file capture: bytes under a filename, `captureMode` blob. The reading an
 * OCR rung would land sits in `text`; `blobId` stays null because conversion
 * files the reading, never the bytes - the bytes live in the capture's own
 * blob and are untouched by this path.
 */
async function addBlobCapture(
  db: NonNullable<typeof holder.db>,
  ws: string,
  userId: string,
  input: { text: string | null; filename: string; mimeType: string },
) {
  const [row] = await db
    .insert(captures)
    .values({
      workspaceId: ws,
      kind: "file",
      captureMode: "blob",
      rawPayload: { filename: input.filename, mimeType: input.mimeType, sizeBytes: 1024, contentHash: "test-hash" },
      text: input.text,
      createdBy: userId,
      updatedBy: userId,
    })
    .returning();
  return row;
}

/** The provenance row the OCR rung writes when it reads a capture's bytes. */
async function seedOcrAudit(db: NonNullable<typeof holder.db>, ws: string, captureId: string, extractor: string) {
  await db.insert(auditEvents).values({
    workspaceId: ws,
    actorKind: "system",
    action: "capture.extracted",
    subjectType: "capture",
    subjectId: captureId,
    summary: `Read with ${extractor}`,
    metadata: { actor: "ocr", extractor },
  });
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

    const [queued] = await holder
      .db!.select()
      .from(outboxEvents)
      .where(and(eq(outboxEvents.workspaceId, workspaceId), eq(outboxEvents.topic, "document.extraction_requested")));
    expect(queued).toBeTruthy();
  });

  it("prefers the conversion title, then the capture's own title, over the first line", async () => {
    const { userId, workspaceId } = await seedWorkspace(holder.db!, `c2d-title-${Date.now()}`);
    const auth = ownerAuth(userId, workspaceId);

    // The capture's own title beats the first line of the body.
    const titled = await addTextCapture(holder.db!, workspaceId, userId, BODY, "Captured title");
    const viaCapture = await convertCaptureToDocument(auth, { captureId: titled.id, expectedVersion: titled.version });
    const [captureTitled] = await holder.db!.select().from(documents).where(eq(documents.id, viaCapture.documentId!));
    expect(captureTitled.title).toBe("Captured title");

    // A title passed at conversion time beats the stored one.
    const bare = await addTextCapture(holder.db!, workspaceId, userId, BODY);
    const viaInput = await convertCaptureToDocument(auth, {
      captureId: bare.id,
      expectedVersion: bare.version,
      title: "Conversion title",
    });
    const [inputTitled] = await holder.db!.select().from(documents).where(eq(documents.id, viaInput.documentId!));
    expect(inputTitled.title).toBe("Conversion title");
  });

  it("feeds the existing pipeline: extraction succeeds from the bytes, zettel proposals quote it verbatim", async () => {
    const { userId, workspaceId } = await seedWorkspace(holder.db!, `c2d-pipe-${Date.now()}`);
    const auth = ownerAuth(userId, workspaceId);
    const capture = await addTextCapture(holder.db!, workspaceId, userId, BODY);

    const { documentId } = await convertCaptureToDocument(auth, {
      captureId: capture.id,
      expectedVersion: capture.version,
    });
    const extraction = await extractDocument(auth, { documentId: documentId! });
    expect(extraction.ok).toBe(true);

    const { proposals: created } = await proposeZettels(auth, {
      documentId: documentId!,
      extractor: {
        name: "test-extractor",
        extract: async () => [
          {
            title: "One idea per card",
            claim: "A zettel holds exactly one idea.",
            quote: "A zettel carries one idea, verbatim evidence",
          },
          { title: "Invented", claim: "Not in the text.", quote: "this passage was never written down anywhere" },
        ],
      },
    });
    expect(created).toHaveLength(1); // the invented quote is dropped
    expect(created[0].quote).toBe("A zettel carries one idea, verbatim evidence");
    const [extractionRow] = await holder
      .db!.select()
      .from(documentExtractions)
      .where(and(eq(documentExtractions.documentId, documentId!), eq(documentExtractions.status, "succeeded")));
    expect(created[0].extractionId).toBe(extractionRow.id);
    const [proposal] = await holder
      .db!.select()
      .from(zettelProposals)
      .where(eq(zettelProposals.documentId, documentId!));
    expect(proposal.status).toBe("proposed");
  });

  it("refuses a second conversion and a stale version", async () => {
    const { userId, workspaceId } = await seedWorkspace(holder.db!, `c2d-guards-${Date.now()}`);
    const auth = ownerAuth(userId, workspaceId);
    const capture = await addTextCapture(holder.db!, workspaceId, userId, BODY);

    await expect(
      convertCaptureToDocument(auth, { captureId: capture.id, expectedVersion: capture.version + 1 }),
    ).rejects.toBeInstanceOf(StaleWriteError);
    await convertCaptureToDocument(auth, { captureId: capture.id, expectedVersion: capture.version });
    await expect(
      convertCaptureToDocument(auth, { captureId: capture.id, expectedVersion: capture.version }),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it("refuses a capture with no text and another workspace's capture", async () => {
    const { userId, workspaceId } = await seedWorkspace(holder.db!, `c2d-empty-${Date.now()}`);
    const auth = ownerAuth(userId, workspaceId);
    const empty = await addTextCapture(holder.db!, workspaceId, userId, null);
    await expect(
      convertCaptureToDocument(auth, { captureId: empty.id, expectedVersion: empty.version }),
    ).rejects.toBeInstanceOf(ConflictError);

    const other = await seedWorkspace(holder.db!, `c2d-other-${Date.now()}`);
    const foreign = await addTextCapture(holder.db!, other.workspaceId, other.userId, BODY);
    await expect(
      convertCaptureToDocument(auth, { captureId: foreign.id, expectedVersion: foreign.version }),
    ).rejects.toBeInstanceOf(StaleWriteError);
  });

  it("carries the capture's url onto the document", async () => {
    const { userId, workspaceId } = await seedWorkspace(holder.db!, `c2d-url-${Date.now()}`);
    const auth = ownerAuth(userId, workspaceId);
    const url = `https://example.com/provenance-${Date.now()}`;
    const capture = await createCapture(auth, { text: BODY, url, mode: "selection" });

    const { documentId } = await convertCaptureToDocument(auth, {
      captureId: capture.id,
      expectedVersion: capture.version,
    });

    const [doc] = await holder.db!.select().from(documents).where(eq(documents.id, documentId!));
    expect(doc.sourceUrl).toBe(url);
    expect(doc.title).toBe("Atomic notes compound.");
  });

  it("refuses a second capture of an article already in the library, creating no second document", async () => {
    const { userId, workspaceId } = await seedWorkspace(holder.db!, `c2d-dup-url-${Date.now()}`);
    const auth = ownerAuth(userId, workspaceId);
    const url = `https://example.com/duplicate-${Date.now()}`;
    const first = await createCapture(auth, { text: BODY, url, mode: "selection" });
    const second = await createCapture(auth, { text: `${BODY}\n\nA second reading.`, url, mode: "selection" });

    const { documentId } = await convertCaptureToDocument(auth, {
      captureId: first.id,
      expectedVersion: first.version,
    });

    const error = await convertCaptureToDocument(auth, { captureId: second.id, expectedVersion: second.version }).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(ConflictError);
    expect((error as ConflictError).code).toBe("conflict");
    expect((error as Error).message).toBe("That article is already in your library.");

    const filed = await holder
      .db!.select({ id: documents.id })
      .from(documents)
      .where(and(eq(documents.workspaceId, workspaceId), eq(documents.sourceUrl, url)));
    expect(filed).toHaveLength(1);
    expect(filed[0].id).toBe(documentId);

    const [stillOpen] = await holder.db!.select().from(captures).where(eq(captures.id, second.id));
    expect(stillOpen.processingState).not.toBe("converted");
  });

  it("files an OCR'd image capture's reading with the vision reader as the extractor", async () => {
    const { userId, workspaceId } = await seedWorkspace(holder.db!, `c2d-ocr-${Date.now()}`);
    const auth = ownerAuth(userId, workspaceId);
    const capture = await addBlobCapture(holder.db!, workspaceId, userId, {
      text: BODY,
      filename: "whiteboard.png",
      mimeType: "image/png",
    });
    await seedOcrAudit(holder.db!, workspaceId, capture.id, VISION_EXTRACTOR);

    const { documentId } = await convertCaptureToDocument(auth, {
      captureId: capture.id,
      expectedVersion: capture.version,
    });
    expect(documentId).toBeTruthy();

    // The reading IS the extraction: succeeded on arrival, with the reader
    // that produced it - not a re-parse of the markdown copy.
    const [extraction] = await holder
      .db!.select()
      .from(documentExtractions)
      .where(eq(documentExtractions.documentId, documentId!));
    expect(extraction.status).toBe("succeeded");
    expect(extraction.text).toBe(BODY);
    expect(extraction.extractor).toBe(VISION_EXTRACTOR);
    expect(extraction.spans).toEqual([{ page: 1, start: 0, end: BODY.length }]);

    // The consumer's claim dedupes against the pre-written row - no provider
    // re-read - and the extractor keeps the vision reader's name while the
    // proposal pass runs off the text exactly as off a provider's result.
    const dedup = await extractDocument(auth, { documentId: documentId! });
    expect(dedup.ok).toBe(true);
    if (!dedup.ok) return;
    expect(dedup.deduplicated).toBe(true);
    expect(dedup.text).toBe(BODY);
    const [after] = await holder
      .db!.select()
      .from(documentExtractions)
      .where(eq(documentExtractions.documentId, documentId!));
    expect(after.extractor).toBe(VISION_EXTRACTOR);
    expect(after.proposalStatus).toBe("succeeded");

    // The reading is searchable the moment it files: full-text over the
    // extraction finds the document by a word from the image.
    const hits = await searchDocuments(auth, { query: "compound" });
    expect(hits.map((hit) => hit.id)).toContain(documentId);

    // And the conversion's own extraction pass mirrored the reading into the
    // search graph: the artifact appears with the document, no dispatcher
    // drain needed. The outbox event the intake also enqueued stays pending
    // for the consumer, whose pass dedupes against the same row.
    const [document] = await holder
      .db!.select({ artifactId: documents.artifactId })
      .from(documents)
      .where(eq(documents.id, documentId!));
    expect(document.artifactId).toBeTruthy();
  });

  it("refuses a textless blob: the capture is the file, and nothing invents words", async () => {
    const { userId, workspaceId } = await seedWorkspace(holder.db!, `c2d-blob-empty-${Date.now()}`);
    const auth = ownerAuth(userId, workspaceId);
    const unread = await addBlobCapture(holder.db!, workspaceId, userId, {
      text: null,
      filename: "diagram.png",
      mimeType: "image/png",
    });

    const error = await convertCaptureToDocument(auth, {
      captureId: unread.id,
      expectedVersion: unread.version,
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ConflictError);
    expect((error as ConflictError).message).toBe("That capture has no text to file.");

    // The refusal left no document and no lineage edge behind.
    expect(
      await holder.db!.select({ id: documents.id }).from(documents).where(eq(documents.workspaceId, workspaceId)),
    ).toHaveLength(0);
    const [stillOpen] = await holder.db!.select().from(captures).where(eq(captures.id, unread.id));
    expect(stillOpen.processingState).not.toBe("converted");
  });

  it("files an owner-typed blob reading as plain text - no OCR provenance, no borrowed credit", async () => {
    const { userId, workspaceId } = await seedWorkspace(holder.db!, `c2d-blob-typed-${Date.now()}`);
    const auth = ownerAuth(userId, workspaceId);
    // Text without a `capture.extracted` audit row: the owner's own words.
    const capture = await addBlobCapture(holder.db!, workspaceId, userId, {
      text: BODY,
      filename: "notes.txt",
      mimeType: "text/plain",
    });

    const { documentId } = await convertCaptureToDocument(auth, {
      captureId: capture.id,
      expectedVersion: capture.version,
    });
    expect(documentId).toBeTruthy();

    // The conversion kicks the extraction pass itself (the upload surface's
    // post-commit behavior): the plain-text reader genuinely reads the
    // markdown bytes the conversion filed, so the extractor is its name - no
    // borrowed credit from the capture's reading.
    const [extraction] = await holder
      .db!.select()
      .from(documentExtractions)
      .where(eq(documentExtractions.documentId, documentId!));
    expect(extraction?.extractor).toBe("plain-text@local");
    expect(extraction?.text).toBe(BODY);

    // A second pass - the dispatcher draining the intake's event - dedupes
    // against that row instead of reading the bytes again.
    const dedup = await extractDocument(auth, { documentId: documentId! });
    expect(dedup.ok).toBe(true);
    if (!dedup.ok) return;
    expect(dedup.deduplicated).toBe(true);
    expect(dedup.text).toBe(BODY);
  });
});
