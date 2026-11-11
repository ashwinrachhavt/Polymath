import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { captures } from "@/domains/capture/schema";
import { documents } from "@/domains/knowledge/schema";
import { makeTestDb, seedWorkspace, ownerAuth } from "../helpers/test-workspace";

/*
 * Making flashcards or a quiz from an inbox capture needs the capture as a
 * library document. documentForCapture is that step: it files an open
 * capture, reuses the document a capture was already filed as, and reuses
 * the library's copy of an article captured twice, so picking a capture
 * never fails just because its words are already in the library.
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

import { ConflictError, convertCaptureToDocument, createCapture } from "@/domains/capture/commands";
import { documentForCapture } from "@/domains/capture/document-source";

const BODY =
  "Spaced repetition beats cramming.\n\nReviewing a fact just before it is forgotten strengthens the memory more than reviewing it often.";

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

async function workspace(label: string) {
  const { userId, workspaceId } = await seedWorkspace(holder.db!, `cds-${label}-${Date.now()}`);
  return ownerAuth(userId, workspaceId);
}

async function documentCount(workspaceId: string) {
  return (await holder.db!.select({ id: documents.id }).from(documents).where(eq(documents.workspaceId, workspaceId)))
    .length;
}

suite("documentForCapture", () => {
  it("files an open capture as a document and marks it converted", async () => {
    const auth = await workspace("fresh");
    const capture = await createCapture(auth, { text: BODY });

    const documentId = await documentForCapture(auth, { captureId: capture.id, expectedVersion: capture.version });

    const [doc] = await holder.db!.select().from(documents).where(eq(documents.id, documentId));
    expect(doc.workspaceId).toBe(auth.workspaceId);
    const [after] = await holder.db!.select().from(captures).where(eq(captures.id, capture.id));
    expect(after).toMatchObject({ processingState: "converted", convertedType: "document", convertedId: documentId });
  });

  it("returns the document an already-filed capture became, filing nothing new", async () => {
    const auth = await workspace("filed");
    const capture = await createCapture(auth, { text: BODY });
    const { documentId } = await convertCaptureToDocument(auth, {
      captureId: capture.id,
      expectedVersion: capture.version,
    });
    const before = await documentCount(auth.workspaceId);

    // The caller still holds the version it loaded before filing; filing moved it on.
    const again = await documentForCapture(auth, { captureId: capture.id, expectedVersion: capture.version });

    expect(again).toBe(documentId);
    expect(await documentCount(auth.workspaceId)).toBe(before);
  });

  it("uses the library's copy of an article captured twice, leaving the second capture open", async () => {
    const auth = await workspace("dup");
    const url = `https://example.com/spacing-${Date.now()}`;
    const first = await createCapture(auth, { text: BODY, url, mode: "selection" });
    const second = await createCapture(auth, { text: `${BODY}\n\nA second reading.`, url, mode: "selection" });
    const { documentId } = await convertCaptureToDocument(auth, {
      captureId: first.id,
      expectedVersion: first.version,
    });

    const reused = await documentForCapture(auth, { captureId: second.id, expectedVersion: second.version });

    expect(reused).toBe(documentId);
    const filed = await holder
      .db!.select({ id: documents.id })
      .from(documents)
      .where(and(eq(documents.workspaceId, auth.workspaceId), eq(documents.sourceUrl, url)));
    expect(filed).toHaveLength(1);
    const [stillOpen] = await holder.db!.select().from(captures).where(eq(captures.id, second.id));
    expect(stillOpen.processingState).not.toBe("converted");
  });

  it("refuses a capture that was turned into something other than a document", async () => {
    const auth = await workspace("note");
    const capture = await createCapture(auth, { text: BODY });
    await holder
      .db!.update(captures)
      .set({ processingState: "converted", convertedType: "note", convertedId: crypto.randomUUID() })
      .where(eq(captures.id, capture.id));

    const error = await documentForCapture(auth, { captureId: capture.id, expectedVersion: capture.version }).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(ConflictError);
    expect((error as Error).message).toBe("That capture became a note, so it cannot be a source.");
  });
});
