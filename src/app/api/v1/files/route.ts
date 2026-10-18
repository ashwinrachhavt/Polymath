import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import { authedHandler } from "@/lib/auth";
import { problemResponse } from "@/lib/problems";
import { putBlob } from "@/integrations/object-store/vercel-blob";
import { auditEvents, blobObjects } from "@/domains/audit/schema";
import { documents, files } from "@/domains/knowledge/schema";

/*
 * POST /api/v1/files — upload a document, store the binary in Vercel Blob,
 * record blob_objects + files + documents, and return the document id for the
 * later extraction call. 4.5 MB function body limit is the Vercel ceiling;
 * larger files use the client-upload path when it lands.
 */

const MAX_BYTES = 4 * 1024 * 1024;

const documentMeta = z.object({
  title: z.string().min(1).max(500),
  mimeType: z.string().min(1).max(200),
});

export const POST = authedHandler(async (auth, request) => {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.includes("multipart/form-data")) {
    return problemResponse(415, "unsupported_media_type", "Upload as multipart/form-data.");
  }

  const form = await request.formData();
  const file = form.get("file");
  const rawTitle = form.get("title");
  const parsedTitle = documentMeta.shape.title.safeParse(rawTitle);
  if (!(file instanceof File)) {
    return problemResponse(400, "invalid_request", "Attach a file in the 'file' field.");
  }
  if (!parsedTitle.success) {
    return problemResponse(400, "invalid_request", "Give the document a title.");
  }
  if (file.size > MAX_BYTES) {
    return problemResponse(413, "payload_too_large", "Files are limited to 4 MB.");
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  const stored = await putBlob({
    bytes,
    filename: file.name,
    contentType: file.type || "application/octet-stream",
    workspaceId: auth.workspaceId,
  });

  const [document] = await db.transaction(async (tx) => {
    const [blob] = await tx
      .insert(blobObjects)
      .values({
        workspaceId: auth.workspaceId,
        storageKey: stored.storageKey,
        contentHash: stored.contentHash,
        sizeBytes: stored.sizeBytes,
        mimeType: file.type || "application/octet-stream",
        retentionClass: "standard",
        createdBy: auth.userId,
        updatedBy: auth.userId,
      })
      .returning({ id: blobObjects.id });

    const [fileRow] = await tx
      .insert(files)
      .values({
        workspaceId: auth.workspaceId,
        blobId: blob.id,
        filename: file.name,
        status: "uploaded",
        origin: "upload",
        createdBy: auth.userId,
        updatedBy: auth.userId,
      })
      .returning({ id: files.id });

    const [doc] = await tx
      .insert(documents)
      .values({
        workspaceId: auth.workspaceId,
        fileId: fileRow.id,
        title: parsedTitle.data,
        mimeType: file.type || "application/octet-stream",
        createdBy: auth.userId,
        updatedBy: auth.userId,
      })
      .returning({ id: documents.id });

    await tx.insert(auditEvents).values({
      workspaceId: auth.workspaceId,
      actorId: auth.userId,
      actorKind: "user",
      action: "file.uploaded",
      subjectType: "document",
      subjectId: doc.id,
      summary: `Uploaded ${file.name}`,
    });

    return [{ id: doc.id }];
  });

  return Response.json({ documentId: document.id, contentHash: stored.contentHash }, { status: 201 });
});

export const GET = authedHandler(async (auth, request) => {
  const url = new URL(request.url);
  const documentId = url.searchParams.get("documentId");
  if (!documentId) return problemResponse(400, "invalid_request", "Pass a documentId.");

  const [doc] = await db
    .select({ id: documents.id, title: documents.title, mimeType: documents.mimeType })
    .from(documents)
    .where(and(eq(documents.id, documentId), eq(documents.workspaceId, auth.workspaceId)))
    .limit(1);
  if (!doc) return problemResponse(404, "not_found", "No such document in this workspace.");
  return Response.json(doc);
});
