import type { drizzle } from "drizzle-orm/postgres-js";
import { blobObjects } from "@/domains/audit/schema";
import { documentExtractions, documents, files, notebooks } from "@/domains/knowledge/schema";
import type { ownerAuth } from "./test-workspace";

type Db = ReturnType<typeof drizzle>;
type Auth = ReturnType<typeof ownerAuth>;

/** A document whose text has been read: what every learning generator needs as a source. */
export async function seedReadDocument(db: Db, auth: Auth, text: string, title = "Fixture source") {
  const [blob] = await db
    .insert(blobObjects)
    .values({
      workspaceId: auth.workspaceId,
      storageKey: `private/${crypto.randomUUID()}`,
      contentHash: crypto.randomUUID(),
      sizeBytes: text.length,
      mimeType: "text/plain",
    })
    .returning();
  const [file] = await db
    .insert(files)
    .values({ workspaceId: auth.workspaceId, blobId: blob.id, filename: "fixture.txt" })
    .returning();
  const [doc] = await db
    .insert(documents)
    .values({ workspaceId: auth.workspaceId, title, fileId: file.id, mimeType: "text/plain" })
    .returning();
  const [extraction] = await db
    .insert(documentExtractions)
    .values({ workspaceId: auth.workspaceId, documentId: doc.id, contentHash: blob.contentHash, status: "succeeded", text })
    .returning();
  return { documentId: doc.id, extractionId: extraction.id };
}

export async function seedNotebook(db: Db, auth: Auth, title = "Fixture notebook") {
  const [notebook] = await db.insert(notebooks).values({ workspaceId: auth.workspaceId, title }).returning();
  return notebook.id;
}
