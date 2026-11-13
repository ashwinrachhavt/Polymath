import { and, desc, eq, sql } from "drizzle-orm";
import type { AuthContext } from "@/domains/identity/resolve";
import { recordAudit } from "@/domains/audit/record";
import { blobObjects } from "@/domains/audit/schema";
import { db } from "@/lib/db";
import { withTransaction } from "@/lib/db-transaction";
import { sha256Hex } from "@/lib/hash";
import { MAX_UPLOAD_BYTES } from "@/lib/file-validation";
import { putBlob } from "@/integrations/object-store/object-store";
import { composioNotionClient, type NotionClient, type NotionSearchHit } from "@/integrations/notion/client";
import { externalLinks, pageHeader } from "@/integrations/notion/markdown";
import { ConflictError, createCapture } from "@/domains/capture/commands";
import { extractDocument } from "@/domains/knowledge/extraction";
import { documentExtractions, documents, files } from "@/domains/knowledge/schema";
import { externalAccounts, syncCursors } from "./schema";

/*
 * The Notion import: shared pages and databases become knowledge documents
 * through the same intake an upload or a URL capture uses, so extraction,
 * embedding, dossiers and search work on them unchanged. source_url is the
 * Notion URL — the dedupe key and the link back — and the file row names the
 * external account and the provider object version it came from.
 *
 * Read-only against Notion, always. A sync from a chosen root page reads the
 * whole tree under it; a sync without one is a watermark sync, where the
 * cursor holds the newest last_edited_time of pages finished cleanly. A page whose new markdown hashes to what is already stored is
 * skipped; a changed page gets a new file version on the same document (the
 * old blob stays), and extraction versions by content hash as usual.
 */

export class NotionImportError extends Error {
  constructor(
    public readonly code: "account_not_found" | "no_connection" | "too_large" | "bad_root",
    message: string,
  ) {
    super(message);
    this.name = "NotionImportError";
  }
}

type NotionPageOutcome = "created" | "updated" | "unchanged" | "failed";

type NotionSyncPage = {
  pageId: string;
  title: string;
  outcome: NotionPageOutcome;
  documentId?: string;
  error?: string;
  /** Present when only part of the page could be read, and says what was missed. */
  partial?: string;
};

export type NotionSyncResult = {
  externalAccountId: string;
  /** The page the walk started from; null for the pass over every shared page. */
  rootPageId: string | null;
  pages: NotionSyncPage[];
  created: number;
  updated: number;
  unchanged: number;
  failed: number;
  /** Pages imported with a part missing. */
  partial: number;
  /** Outside links found in the pages, as inbox captures. */
  links: { captured: number; existing: number; failed: number; deferred: number };
  /** The walk reached its page limit with pages left unread. */
  truncated: boolean;
  watermark: string | null;
};

const SYNC_RESOURCE = "pages";
/** A walk from a chosen page keeps its own state row per root, so two roots never share a cursor. */
const ROOT_RESOURCE_PREFIX = "root:";
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
      : and(
          eq(documents.id, input.documentId),
          eq(documents.workspaceId, auth.workspaceId),
          sql`${documents.fileId} is null`,
        );
    const [attached] = await tx
      .update(documents)
      .set({
        fileId: fileRow.id,
        mimeType: "text/markdown",
        title: input.title.slice(0, 200),
        updatedBy: auth.userId,
        updatedAt: new Date(),
      })
      .where(where)
      .returning({ id: documents.id });
    if (!attached) throw new Error("document changed concurrently");
  });
}

/** A page is imported as far as it was read; this is the note a reader finds where the rest should be. */
function unreadableNote(unreadable: string[]): string {
  if (unreadable.length === 0) return "";
  const reasons = unreadable.slice(0, 3).map((entry) => entry.replace(/^[^:]+: /, ""));
  return `\n> Part of this page could not be read from Notion (${reasons.join("; ")}).\n`;
}

type ImportedPage = {
  outcome: NotionPageOutcome;
  documentId?: string;
  error?: string;
  /** Why only part of the page came in, when that is so. */
  partial?: string;
  /** Where the tree goes from here, and the outside links to capture. */
  childPageIds: string[];
  databaseIds: string[];
  links: string[];
};

async function importOnePage(
  auth: AuthContext,
  input: { hit: NotionSearchHit; client: NotionClient; externalAccountId: string },
): Promise<ImportedPage> {
  const { hit, client } = input;
  const read = await client.readPage(hit.id);
  const found = {
    childPageIds: read.childPageIds,
    databaseIds: read.databaseIds,
    links: externalLinks(read.markdown),
    ...(read.unreadable.length ? { partial: read.unreadable.slice(0, 3).join("; ") } : {}),
  };
  const markdown = pageHeader(hit.title, hit.properties ?? {}) + "\n" + read.markdown + unreadableNote(read.unreadable);
  const bytes = new TextEncoder().encode(markdown);
  if (bytes.byteLength > MAX_UPLOAD_BYTES) {
    return { ...found, outcome: "failed", error: "page exceeds the 4 MB import limit" };
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
    if (current?.contentHash === contentHash) {
      // Same text as last time. An earlier pass may have stopped before its
      // extraction finished, so an unchanged page still gets it if it is missing.
      const [extracted] = await db
        .select({ id: documentExtractions.id })
        .from(documentExtractions)
        .where(
          and(
            eq(documentExtractions.documentId, existing.id),
            eq(documentExtractions.contentHash, contentHash),
            eq(documentExtractions.status, "succeeded"),
          ),
        )
        .limit(1);
      if (!extracted) await extractDocument(auth, { documentId: existing.id });
      return { ...found, outcome: "unchanged", documentId: existing.id };
    }
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
    return { ...found, outcome: "updated", documentId: existing.id };
  }

  const documentId =
    existing?.id ??
    (
      await db
        .insert(documents)
        .values({
          workspaceId: auth.workspaceId,
          title: hit.title.slice(0, 200),
          sourceUrl: hit.url,
          createdBy: auth.userId,
          updatedBy: auth.userId,
        })
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
  if (!documentId) return { ...found, outcome: "failed", error: "document could not be created" };

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
  return { ...found, outcome: existing ? "updated" : "created", documentId };
}

/** The page's own import, with a failure kept as an outcome so one page never stops the pass. */
async function importPageSafely(
  auth: AuthContext,
  input: { hit: NotionSearchHit; client: NotionClient; externalAccountId: string },
): Promise<ImportedPage> {
  try {
    return await importOnePage(auth, input);
  } catch (cause) {
    return {
      outcome: "failed",
      error: cause instanceof Error ? cause.message : "import failed",
      childPageIds: [],
      databaseIds: [],
      links: [],
    };
  }
}

/** The most pages one pass will read under a root, and the most links it will turn into captures. */
const MAX_TREE_PAGES = 400;
const MAX_LINK_CAPTURES = 500;

/** Says where a long sync is; a cancelled job's callback throws, which stops the pass. */
type SyncProgress = (step: string, counts: { done: number; total: number }) => Promise<void>;

type Visit = { pages: NotionSyncPage[]; links: Map<string, { title: string; url: string }>; truncated: boolean };

/**
 * Reads the page the person chose and everything under it: child pages, pages
 * a block links to, and the rows of embedded databases. Each page is visited
 * once. A page or database that cannot be read is named in the result; the
 * walk goes on with the rest.
 */
async function walkTree(
  auth: AuthContext,
  input: { client: NotionClient; externalAccountId: string; rootPageId: string; progress?: SyncProgress },
): Promise<Visit> {
  const visit: Visit = { pages: [], links: new Map(), truncated: false };
  const queued = new Set<string>([normalizeId(input.rootPageId)]);
  const queue: { id: string; hit?: NotionSearchHit }[] = [{ id: input.rootPageId }];
  const enqueue = (id: string, hit?: NotionSearchHit) => {
    const key = normalizeId(id);
    if (queued.has(key)) return;
    queued.add(key);
    queue.push({ id, hit });
  };
  while (queue.length > 0) {
    if (visit.pages.length >= MAX_TREE_PAGES) {
      visit.truncated = true;
      break;
    }
    const next = queue.shift()!;
    let hit = next.hit;
    if (!hit) {
      try {
        hit = await input.client.getPage(next.id);
      } catch (cause) {
        visit.pages.push({
          pageId: next.id,
          title: "A page Notion would not open",
          outcome: "failed",
          error: cause instanceof Error ? cause.message : "page could not be opened",
        });
        continue;
      }
    }
    if (hit.archived) continue;
    const result = await importPageSafely(auth, {
      hit,
      client: input.client,
      externalAccountId: input.externalAccountId,
    });
    visit.pages.push(pageEntry(hit, result));
    for (const link of result.links)
      if (!visit.links.has(link)) visit.links.set(link, { title: hit.title, url: hit.url });
    for (const id of result.childPageIds) enqueue(id);
    for (const databaseId of result.databaseIds) {
      try {
        for (const row of await input.client.queryDatabaseRows(databaseId)) enqueue(row.id, row);
      } catch (cause) {
        visit.pages.push({
          pageId: databaseId,
          title: "A database Notion would not open",
          outcome: "failed",
          error: cause instanceof Error ? cause.message : "database could not be read",
        });
      }
    }
    await input.progress?.("Reading Notion", { done: visit.pages.length, total: visit.pages.length + queue.length });
  }
  return visit;
}

function normalizeId(id: string): string {
  return id.replaceAll("-", "").toLowerCase();
}

function pageEntry(hit: NotionSearchHit, result: ImportedPage): NotionSyncPage {
  return {
    pageId: hit.id,
    title: hit.title,
    outcome: result.outcome,
    ...(result.documentId ? { documentId: result.documentId } : {}),
    ...(result.error ? { error: result.error } : {}),
    ...(result.partial ? { partial: result.partial } : {}),
  };
}

/**
 * Turns the outside links the pages carried into inbox captures, the same
 * rows a pasted link makes: reading the page behind one stays the owner's
 * call, through the usual retry on the capture. A link already captured is
 * counted, not added again.
 */
async function captureLinks(
  auth: AuthContext,
  links: Map<string, { title: string; url: string }>,
): Promise<NotionSyncResult["links"]> {
  const outcome = { captured: 0, existing: 0, failed: 0, deferred: 0 };
  let attempted = 0;
  for (const [url, from] of links) {
    if (attempted >= MAX_LINK_CAPTURES) {
      outcome.deferred += 1;
      continue;
    }
    attempted += 1;
    try {
      await createCapture(auth, {
        text: url,
        url,
        mode: "url-reference",
        source: "import",
        context: {
          source: { kind: "document", title: from.title.slice(0, 500), ...(from.url ? { url: from.url } : {}) },
        },
      });
      outcome.captured += 1;
    } catch (cause) {
      if (cause instanceof ConflictError) outcome.existing += 1;
      else outcome.failed += 1;
    }
  }
  return outcome;
}

/** The id inside a Notion page link or a bare id, in the dashed form the API returns; null when there is none. */
export function parseNotionPageId(input: string): string | null {
  const hex = /([0-9a-f]{8})-?([0-9a-f]{4})-?([0-9a-f]{4})-?([0-9a-f]{4})-?([0-9a-f]{12})(?![0-9a-f])/i.exec(
    input.split("?")[0] ?? "",
  );
  return hex ? hex.slice(1).join("-").toLowerCase() : null;
}

/**
 * One sync pass over a connected Notion account.
 *
 * With `rootPageId` it reads that page and everything under it (walkTree),
 * every time: a page's edits do not touch its parent, so the only way to find
 * a new child is to read down the tree, and the content hash is what keeps a
 * second pass from changing anything. Without a root it is the older
 * watermark pass over every shared page. The watermark moves only through
 * pages that are done: it stops before the first page that failed, so that
 * page, and any edited after it, is read again next time.
 */
export async function syncNotionAccount(
  auth: AuthContext,
  input: {
    externalAccountId: string;
    client?: NotionClient;
    pageLimit?: number;
    rootPageId?: string;
    progress?: SyncProgress;
  },
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
  const rootPageId = input.rootPageId ? parseNotionPageId(input.rootPageId) : null;
  if (input.rootPageId && !rootPageId) {
    throw new NotionImportError("bad_root", "That does not look like a Notion page link.");
  }
  const resource = rootPageId ? `${ROOT_RESOURCE_PREFIX}${normalizeId(rootPageId)}` : SYNC_RESOURCE;

  const [cursorRow] = await db
    .select()
    .from(syncCursors)
    .where(and(eq(syncCursors.externalAccountId, account.id), eq(syncCursors.resource, resource)))
    .limit(1);
  const watermark = rootPageId ? null : (cursorRow?.cursor ?? null);

  await markCursor(auth, account.id, resource, { state: "running" });
  try {
    let pages: NotionSyncPage[];
    let links: Visit["links"];
    let truncated = false;
    let newest = watermark;
    if (rootPageId) {
      const visit = await walkTree(auth, {
        client,
        externalAccountId: account.id,
        rootPageId,
        progress: input.progress,
      });
      ({ pages, links, truncated } = visit);
    } else {
      const hits = (await client.searchEditedSince(watermark))
        .filter((h) => h.object === "page")
        .sort((x, y) => x.lastEditedTime.localeCompare(y.lastEditedTime))
        .slice(0, input.pageLimit ?? DEFAULT_PAGE_LIMIT);
      pages = [];
      links = new Map();
      let blocked = false;
      for (const hit of hits) {
        const result = await importPageSafely(auth, { hit, client, externalAccountId: account.id });
        pages.push(pageEntry(hit, result));
        for (const link of result.links) if (!links.has(link)) links.set(link, { title: hit.title, url: hit.url });
        await input.progress?.("Reading Notion", { done: pages.length, total: hits.length });
        if (result.outcome === "failed") blocked = true;
        else if (!blocked && hit.lastEditedTime && (!newest || hit.lastEditedTime > newest))
          newest = hit.lastEditedTime;
      }
    }
    const linkOutcome = await captureLinks(auth, links);
    const failed = pages.filter((p) => p.outcome === "failed").length;
    const incomplete = failed > 0 || truncated || pages.some((p) => p.partial);
    await markCursor(auth, account.id, resource, {
      state: incomplete ? "partial" : "idle",
      cursor: newest,
      lastSyncedAt: new Date(),
      lastError: incomplete
        ? incompleteReason({ failed, truncated, partial: pages.filter((p) => p.partial).length })
        : null,
    });
    // Its own transaction instead of a bare auto-commit insert, like every
    // other audit write in the codebase.
    await withTransaction(async (tx) => {
      await recordAudit(
        auth,
        {
          action: "integration.notion_synced",
          subjectType: "external_account",
          subjectId: account.id,
          summary: `Notion sync: ${pages.length} page${pages.length === 1 ? "" : "s"} seen, ${failed} failed`,
        },
        tx,
      );
    });
    return {
      externalAccountId: account.id,
      rootPageId,
      pages,
      created: pages.filter((p) => p.outcome === "created").length,
      updated: pages.filter((p) => p.outcome === "updated").length,
      unchanged: pages.filter((p) => p.outcome === "unchanged").length,
      failed,
      partial: pages.filter((p) => p.partial).length,
      links: linkOutcome,
      truncated,
      watermark: newest,
    };
  } catch (cause) {
    await markCursor(auth, account.id, resource, {
      state: "failed",
      lastError: cause instanceof Error ? cause.message : "sync failed",
    });
    throw cause;
  }
}

function incompleteReason(input: { failed: number; truncated: boolean; partial: number }): string {
  const parts = [
    input.failed ? `${input.failed} page${input.failed === 1 ? "" : "s"} failed` : null,
    input.partial ? `${input.partial} read only in part` : null,
    input.truncated ? `stopped at ${MAX_TREE_PAGES} pages` : null,
  ];
  return parts.filter(Boolean).join(", ");
}

/** The sentence a person reads after a sync: what came in, what did not, and why. */
export function summarizeNotionSync(result: NotionSyncResult): string {
  const total = result.pages.length;
  const sentences = [
    `${total} page${total === 1 ? "" : "s"} read: ${result.created} new, ${result.updated} updated, ${result.unchanged} unchanged.`,
  ];
  const skipped = result.pages.filter((p) => p.outcome === "failed");
  if (skipped.length) {
    const named = skipped.slice(0, 3).map((p) => `${p.title} (${p.error ?? "failed"})`);
    const more = skipped.length > 3 ? `, and ${skipped.length - 3} more` : "";
    sentences.push(`${skipped.length} skipped: ${named.join("; ")}${more}.`);
  }
  if (result.partial) sentences.push(`${result.partial} read only in part.`);
  if (result.truncated) sentences.push(`Stopped at ${MAX_TREE_PAGES} pages; sync again to continue.`);
  const { captured, existing, failed, deferred } = result.links;
  if (captured || existing || failed || deferred) {
    const extras = [
      existing ? `${existing} already there` : null,
      failed ? `${failed} could not be added` : null,
      deferred ? `${deferred} left for the next sync` : null,
    ].filter(Boolean);
    sentences.push(
      `${captured} link${captured === 1 ? "" : "s"} added to the inbox${extras.length ? ` (${extras.join(", ")})` : ""}.`,
    );
  }
  return sentences.join(" ");
}

async function markCursor(
  auth: AuthContext,
  externalAccountId: string,
  resource: string,
  patch: {
    state: "idle" | "running" | "partial" | "failed";
    cursor?: string | null;
    lastSyncedAt?: Date;
    lastError?: string | null;
  },
) {
  const [existing] = await db
    .select({ id: syncCursors.id })
    .from(syncCursors)
    .where(and(eq(syncCursors.externalAccountId, externalAccountId), eq(syncCursors.resource, resource)))
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
      resource,
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
