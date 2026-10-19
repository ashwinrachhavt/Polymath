import { and, desc, eq, sql } from "drizzle-orm";
import type { AuthContext } from "@/domains/identity/resolve";
import { auditEvents, blobObjects } from "@/domains/audit/schema";
import { db } from "@/lib/db";
import { withTransaction } from "@/lib/db-transaction";
import { sha256Hex } from "@/lib/hash";
import { MAX_UPLOAD_BYTES } from "@/lib/file-validation";
import { putBlob } from "@/integrations/object-store/object-store";
import { composioNotionClient, type NotionClient, type NotionSearchHit } from "@/integrations/notion/client";
import { pageHeader } from "@/integrations/notion/markdown";
import { extractDocument } from "@/domains/knowledge/extraction";
import { documents, files } from "@/domains/knowledge/schema";
import { externalAccounts, syncCursors } from "./schema";

/*
 * The Notion import: shared pages and databases become knowledge documents
 * through the same intake an upload or a URL capture uses, so extraction,
 * embedding, dossiers and search work on them unchanged. source_url is the
 * Notion URL — the dedupe key and the link back — and the file row names the
 * external account and the provider object version it came from.
 *
 * Read-only against Notion, always. Re-sync is a watermark sync: the cursor
 * holds the newest last_edited_time seen, and only pages edited after it are
 * read again. A page whose new markdown hashes to what is already stored is
 * skipped; a changed page gets a new file version on the same document (the
 * old blob stays), and extraction versions by content hash as usual.
 */

export class NotionImportError extends Error {
  constructor(
    public readonly code: "account_not_found" | "no_connection" | "too_large",
    message: string,
  ) {
    super(message);
    this.name = "NotionImportError";
  }
}

export type NotionPageOutcome = "created" | "updated" | "unchanged" | "failed";

export type NotionSyncResult = {
  externalAccountId: string;
  pages: { pageId: string; title: string; outcome: NotionPageOutcome; documentId?: string; error?: string }[];
  created: number;
  updated: number;
  unchanged: number;
  failed: number;
  watermark: string | null;
};

const SYNC_RESOURCE = "pages";
const DEFAULT_PAGE_LIMIT = 50;

/** Attaches the markdown as the document's first file, or replaces it with the new version. */
async function attachMarkdown(
  auth: AuthContext,
  input: {
    documentId: string;
    title: string;
    bytes: Uint8Array;
    contentHash: string;
    externalAccountId: string;
    providerObjectId: string;
    replace: boolean;
  },
): Promise<void> {
  const stored = await putBlob({
    bytes: input.bytes,
    filename: `${input.title.slice(0, 80)}.md`,
    contentType: "text/markdown",
    workspaceId: auth.workspaceId,
    contentHash: input.contentHash,
  });
  await withTransaction(async (tx) => {
    const blob =
      (
        await tx
          .insert(blobObjects)
          .values({
            workspaceId: auth.workspaceId,
            storageKey: stored.storageKey,
            contentHash: stored.contentHash,
            sizeBytes: stored.sizeBytes,
            mimeType: "text/markdown",
            retentionClass: "standard",
            createdBy: auth.userId,
            updatedBy: auth.userId,
          })
          .onConflictDoNothing({ target: blobObjects.storageKey })
          .returning({ id: blobObjects.id })
      )[0] ??
      (
        await tx
          .select({ id: blobObjects.id })
          .from(blobObjects)
          .where(eq(blobObjects.storageKey, stored.storageKey))
          .limit(1)
      )[0];
    const [fileRow] = await tx
      .insert(files)
      .values({
        workspaceId: auth.workspaceId,
        blobId: blob.id,
        filename: `${input.title.slice(0, 80)}.md`,
        status: "uploaded",
        origin: "notion",
        externalAccountId: input.externalAccountId,
        providerObjectId: input.providerObjectId,
        createdBy: auth.userId,
        updatedBy: auth.userId,
      })
      .returning({ id: files.id });
    const where = input.replace
      ? and(eq(documents.id, input.documentId), eq(documents.workspaceId, auth.workspaceId))
      : and(eq(documents.id, input.documentId), eq(documents.workspaceId, auth.workspaceId), sql`${documents.fileId} is null`);
    const [attached] = await tx
      .update(documents)
      .set({ fileId: fileRow.id, mimeType: "text/markdown", title: input.title.slice(0, 200), updatedBy: auth.userId, updatedAt: new Date() })
      .where(where)
      .returning({ id: documents.id });
    if (!attached) throw new Error("document changed concurrently");
  });
}

async function importOnePage(
  auth: AuthContext,
  input: { hit: NotionSearchHit; client: NotionClient; externalAccountId: string },
): Promise<{ outcome: NotionPageOutcome; documentId?: string; error?: string }> {
  const { hit, client } = input;
  const markdown = pageHeader(hit.title, hit.properties ?? {}) + "\n" + (await client.getPageMarkdown(hit.id));
  const bytes = new TextEncoder().encode(markdown);
  if (bytes.byteLength > MAX_UPLOAD_BYTES) {
    return { outcome: "failed", error: "page exceeds the 4 MB import limit" };
  }
  const contentHash = await sha256Hex(bytes);

  const [existing] = await db
    .select({ id: documents.id, fileId: documents.fileId })
    .from(documents)
    .where(and(eq(documents.workspaceId, auth.workspaceId), eq(documents.sourceUrl, hit.url)))
    .limit(1);

  if (existing?.fileId) {
    const [current] = await db
      .select({ contentHash: blobObjects.contentHash })
      .from(files)
      .innerJoin(blobObjects, eq(blobObjects.id, files.blobId))
      .where(eq(files.id, existing.fileId))
      .limit(1);
    if (current?.contentHash === contentHash) return { outcome: "unchanged", documentId: existing.id };
    await attachMarkdown(auth, {
      documentId: existing.id,
      title: hit.title,
      bytes,
      contentHash,
      externalAccountId: input.externalAccountId,
      providerObjectId: `${hit.id}:${contentHash}`,
      replace: true,
    });
    await extractDocument(auth, { documentId: existing.id });
    return { outcome: "updated", documentId: existing.id };
  }

  const documentId =
    existing?.id ??
    (
      await db
        .insert(documents)
        .values({ workspaceId: auth.workspaceId, title: hit.title.slice(0, 200), sourceUrl: hit.url, createdBy: auth.userId, updatedBy: auth.userId })
        .onConflictDoNothing()
        .returning({ id: documents.id })
    )[0]?.id ??
    (
      await db
        .select({ id: documents.id })
        .from(documents)
        .where(and(eq(documents.workspaceId, auth.workspaceId), eq(documents.sourceUrl, hit.url)))
        .limit(1)
    )[0]?.id;
  if (!documentId) return { outcome: "failed", error: "document could not be created" };

  await attachMarkdown(auth, {
    documentId,
    title: hit.title,
    bytes,
    contentHash,
    externalAccountId: input.externalAccountId,
    providerObjectId: `${hit.id}:${contentHash}`,
    replace: false,
  });
  await extractDocument(auth, { documentId });
  return { outcome: existing ? "updated" : "created", documentId };
}

/**
 * One sync pass over a connected Notion account. Pages first; each database
 * also contributes its rows (row pages import like any other page). The
 * watermark moves only to the newest edit actually seen, and a page that
 * fails does not stop the pass — it is counted and named in the result.
 */
export async function syncNotionAccount(
  auth: AuthContext,
  input: { externalAccountId: string; client?: NotionClient; pageLimit?: number },
): Promise<NotionSyncResult> {
  const [account] = await db
    .select()
    .from(externalAccounts)
    .where(and(eq(externalAccounts.id, input.externalAccountId), eq(externalAccounts.workspaceId, auth.workspaceId)))
    .limit(1);
  if (!account || account.provider !== "notion") {
    throw new NotionImportError("account_not_found", "No Notion account with that id in this workspace.");
  }
  if (!account.composioConnectedAccountId && !input.client) {
    throw new NotionImportError("no_connection", "This Notion account has no Composio connection yet.");
  }
  const client = input.client ?? composioNotionClient(account.composioConnectedAccountId!);

  const [cursorRow] = await db
    .select()
    .from(syncCursors)
    .where(and(eq(syncCursors.externalAccountId, account.id), eq(syncCursors.resource, SYNC_RESOURCE)))
    .limit(1);
  const watermark = cursorRow?.cursor ?? null;

  await markCursor(auth, account.id, { state: "running" });
  try {
    const hits = await client.searchEditedSince(watermark);
    const pages: NotionSyncResult["pages"] = [];
    let newest = watermark;
    const pageHits = hits.filter((h) => h.object === "page").slice(0, input.pageLimit ?? DEFAULT_PAGE_LIMIT);
    for (const hit of pageHits) {
      try {
        const result = await importOnePage(auth, { hit, client, externalAccountId: account.id });
        pages.push({ pageId: hit.id, title: hit.title, ...result });
      } catch (cause) {
        pages.push({ pageId: hit.id, title: hit.title, outcome: "failed", error: cause instanceof Error ? cause.message : "import failed" });
      }
      if (hit.lastEditedTime && (!newest || hit.lastEditedTime > newest)) newest = hit.lastEditedTime;
    }
    const failed = pages.filter((p) => p.outcome === "failed").length;
    await markCursor(auth, account.id, {
      state: failed ? "partial" : "idle",
      cursor: newest,
      lastSyncedAt: new Date(),
      lastError: failed ? `${failed} page${failed === 1 ? "" : "s"} failed` : null,
    });
    await db.insert(auditEvents).values({
      workspaceId: auth.workspaceId,
      actorId: auth.userId,
      actorKind: "user",
      action: "integration.notion_synced",
      subjectType: "external_account",
      subjectId: account.id,
      summary: `Notion sync: ${pages.length} page${pages.length === 1 ? "" : "s"} seen, ${failed} failed`,
    });
    return {
      externalAccountId: account.id,
      pages,
      created: pages.filter((p) => p.outcome === "created").length,
      updated: pages.filter((p) => p.outcome === "updated").length,
      unchanged: pages.filter((p) => p.outcome === "unchanged").length,
      failed,
      watermark: newest,
    };
  } catch (cause) {
    await markCursor(auth, account.id, { state: "failed", lastError: cause instanceof Error ? cause.message : "sync failed" });
    throw cause;
  }
}

async function markCursor(
  auth: AuthContext,
  externalAccountId: string,
  patch: { state: "idle" | "running" | "partial" | "failed"; cursor?: string | null; lastSyncedAt?: Date; lastError?: string | null },
) {
  const [existing] = await db
    .select({ id: syncCursors.id })
    .from(syncCursors)
    .where(and(eq(syncCursors.externalAccountId, externalAccountId), eq(syncCursors.resource, SYNC_RESOURCE)))
    .limit(1);
  if (existing) {
    await db
      .update(syncCursors)
      .set({ ...patch, updatedAt: new Date(), updatedBy: auth.userId })
      .where(eq(syncCursors.id, existing.id));
  } else {
    await db.insert(syncCursors).values({
      workspaceId: auth.workspaceId,
      externalAccountId,
      resource: SYNC_RESOURCE,
      cursor: patch.cursor ?? null,
      state: patch.state,
      lastSyncedAt: patch.lastSyncedAt,
      lastError: patch.lastError,
      createdBy: auth.userId,
      updatedBy: auth.userId,
    });
  }
}

/** The accounts a workspace can sync from, newest first — the sync form's choices. */
export async function listNotionAccounts(auth: AuthContext) {
  return db
    .select({
      id: externalAccounts.id,
      alias: externalAccounts.alias,
      status: externalAccounts.status,
      connected: sql<boolean>`${externalAccounts.composioConnectedAccountId} is not null`,
      lastSyncedAt: syncCursors.lastSyncedAt,
      syncState: syncCursors.state,
    })
    .from(externalAccounts)
    .leftJoin(
      syncCursors,
      and(eq(syncCursors.externalAccountId, externalAccounts.id), eq(syncCursors.resource, SYNC_RESOURCE)),
    )
    .where(and(eq(externalAccounts.workspaceId, auth.workspaceId), eq(externalAccounts.provider, "notion")))
    .orderBy(desc(externalAccounts.createdAt));
}
