import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { NotionClient, NotionSearchHit } from "@/integrations/notion/client";
import { makeTestDb, seedWorkspace } from "../helpers/test-workspace";

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

import { listNotionAccounts, NotionImportError, syncNotionAccount } from "@/domains/integrations/notion";
import { externalAccounts, syncCursors } from "@/domains/integrations/schema";
import { documents, documentExtractions, files } from "@/domains/knowledge/schema";

beforeAll(() => { holder.db = handle?.db; });
afterAll(async () => { vi.unstubAllEnvs(); await handle?.client.end(); });
beforeEach(() => { vi.stubEnv("AXIOM_LOCAL_BLOB_DIR", `/tmp/axiom-blobs-${process.pid}`); });

function page(id: string, title: string, edited: string, extra?: Partial<NotionSearchHit>): NotionSearchHit {
  return {
    id,
    object: "page",
    title,
    url: `https://www.notion.so/${title.replaceAll(" ", "-")}-${id.replaceAll("-", "")}`,
    lastEditedTime: edited,
    parentType: "workspace",
    properties: {},
    ...extra,
  };
}

function fakeClient(pages: NotionSearchHit[], bodies: Record<string, string>): NotionClient & { markdownCalls: string[] } {
  const calls: string[] = [];
  return {
    markdownCalls: calls,
    async searchEditedSince(since) {
      return pages.filter((p) => !since || p.lastEditedTime > since);
    },
    async getPageMarkdown(pageId) {
      calls.push(pageId);
      return bodies[pageId] ?? `${pageId} body.\n`;
    },
    async queryDatabaseRows() {
      return [];
    },
  };
}

async function seedAccount(workspaceId: string, userId: string, provider = "notion") {
  const [account] = await handle!.db
    .insert(externalAccounts)
    .values({ workspaceId, provider, alias: `notion-${crypto.randomUUID().slice(0, 8)}`, createdBy: userId, updatedBy: userId, status: "active" })
    .returning();
  return account;
}

suite("notion import", { timeout: 30_000 }, () => {
  it("imports pages as documents, extracts them, and advances the watermark", async () => {
    const a = await seedWorkspace(handle!.db, `notion-basic-${Date.now()}`);
    const auth = { userId: a.userId, workspaceId: a.workspaceId, role: "owner" as const };
    const account = await seedAccount(a.workspaceId, a.userId);
    const pages = [page("p1", "Reading List", "2026-10-01T10:00:00.000Z"), page("p2", "Goals", "2026-10-02T10:00:00.000Z")];
    const client = fakeClient(pages, { p1: "Books to read.\n", p2: "Quarterly goals.\n" });

    const result = await syncNotionAccount(auth, { externalAccountId: account.id, client });
    expect(result.created).toBe(2);
    expect(result.failed).toBe(0);
    expect(result.watermark).toBe("2026-10-02T10:00:00.000Z");

    const db = handle!.db;
    const docs = await db.select().from(documents).where(eq(documents.workspaceId, a.workspaceId));
    expect(docs).toHaveLength(2);
    expect(docs.map((d) => d.sourceUrl).sort()).toEqual(pages.map((p) => p.url).sort());

    // Extraction ran on the markdown: a succeeded row per document.
    const extractions = await db.select().from(documentExtractions).where(eq(documentExtractions.workspaceId, a.workspaceId));
    expect(extractions.filter((e) => e.status === "succeeded").length).toBe(2);
    expect(extractions[0]?.text).toContain("Books to read.");

    // The file names its provider object and account.
    const fileRows = await db.select().from(files).where(eq(files.workspaceId, a.workspaceId));
    expect(fileRows).toHaveLength(2);
    expect(fileRows[0]?.origin).toBe("notion");
    expect(fileRows[0]?.externalAccountId).toBe(account.id);
    expect(fileRows[0]?.providerObjectId).toMatch(/^p[12]:[0-9a-f]{64}$/);

    const [cursor] = await db.select().from(syncCursors).where(eq(syncCursors.externalAccountId, account.id));
    expect(cursor.cursor).toBe("2026-10-02T10:00:00.000Z");
    expect(cursor.state).toBe("idle");
  });

  it("a second sync imports nothing; an edited page updates the same document in place", async () => {
    const a = await seedWorkspace(handle!.db, `notion-resync-${Date.now()}`);
    const auth = { userId: a.userId, workspaceId: a.workspaceId, role: "owner" as const };
    const account = await seedAccount(a.workspaceId, a.userId);
    const hit = page("p1", "Reading List", "2026-10-01T10:00:00.000Z");
    const client = fakeClient([hit], { p1: "Version one.\n" });
    await syncNotionAccount(auth, { externalAccountId: account.id, client });

    const again = await syncNotionAccount(auth, { externalAccountId: account.id, client });
    expect(again.pages).toHaveLength(0);
    expect(again.created + again.updated + again.unchanged).toBe(0);

    // The page changes upstream: same document, new file version, new extraction.
    const edited = page("p1", "Reading List", "2026-10-05T10:00:00.000Z");
    const client2 = fakeClient([edited], { p1: "Version two.\n" });
    const third = await syncNotionAccount(auth, { externalAccountId: account.id, client: client2 });
    expect(third.updated).toBe(1);
    const db = handle!.db;
    const docs = await db.select().from(documents).where(eq(documents.workspaceId, a.workspaceId));
    expect(docs).toHaveLength(1);
    const fileRows = await db.select().from(files).where(eq(files.workspaceId, a.workspaceId));
    expect(fileRows).toHaveLength(2);
    const extractions = await db
      .select()
      .from(documentExtractions)
      .where(eq(documentExtractions.documentId, docs[0]!.id));
    const texts = extractions.filter((e) => e.status === "succeeded").map((e) => e.text);
    expect(texts.some((t) => t?.includes("Version two."))).toBe(true);
  });

  it("an unchanged edit timestamp skips the read entirely", async () => {
    const a = await seedWorkspace(handle!.db, `notion-skip-${Date.now()}`);
    const auth = { userId: a.userId, workspaceId: a.workspaceId, role: "owner" as const };
    const account = await seedAccount(a.workspaceId, a.userId);
    const hit = page("p1", "Stable", "2026-10-01T10:00:00.000Z");
    const client = fakeClient([hit], { p1: "Same body.\n" });
    await syncNotionAccount(auth, { externalAccountId: account.id, client });
    expect(client.markdownCalls).toEqual(["p1"]);
    // Same last_edited_time: the watermark filter drops it before any read.
    const client2 = fakeClient([hit], { p1: "Same body.\n" });
    const res = await syncNotionAccount(auth, { externalAccountId: account.id, client: client2 });
    expect(client2.markdownCalls).toEqual([]);
    expect(res.pages).toHaveLength(0);
  });

  it("a failing page is counted and named without stopping the pass", async () => {
    const a = await seedWorkspace(handle!.db, `notion-fail-${Date.now()}`);
    const auth = { userId: a.userId, workspaceId: a.workspaceId, role: "owner" as const };
    const account = await seedAccount(a.workspaceId, a.userId);
    const pages = [page("p1", "Good", "2026-10-01T10:00:00.000Z"), page("p2", "Bad", "2026-10-02T10:00:00.000Z")];
    const base = fakeClient(pages, { p1: "Fine.\n", p2: "Broken.\n" });
    const client: NotionClient = {
      ...base,
      async getPageMarkdown(pageId) {
        if (pageId === "p2") throw new Error("notion blew up");
        return base.getPageMarkdown(pageId);
      },
    };
    const result = await syncNotionAccount(auth, { externalAccountId: account.id, client });
    expect(result.created).toBe(1);
    expect(result.failed).toBe(1);
    expect(result.pages.find((p) => p.pageId === "p2")?.error).toContain("notion blew up");
    const [cursor] = await handle!.db.select().from(syncCursors).where(eq(syncCursors.externalAccountId, account.id));
    expect(cursor.state).toBe("partial");
  });

  it("rejects a foreign or wrong-provider account and writes nothing", async () => {
    const a = await seedWorkspace(handle!.db, `notion-wrong-a-${Date.now()}`);
    const b = await seedWorkspace(handle!.db, `notion-wrong-b-${Date.now()}`);
    const auth = { userId: a.userId, workspaceId: a.workspaceId, role: "owner" as const };
    const gmailAccount = await seedAccount(a.workspaceId, a.userId, "gmail");
    await expect(
      syncNotionAccount(auth, { externalAccountId: gmailAccount.id, client: fakeClient([], {}) }),
    ).rejects.toBeInstanceOf(NotionImportError);
    // Another workspace's account id is simply not found.
    await expect(
      syncNotionAccount({ userId: b.userId, workspaceId: b.workspaceId, role: "owner" as const }, { externalAccountId: gmailAccount.id, client: fakeClient([], {}) }),
    ).rejects.toBeInstanceOf(NotionImportError);
  });

  it("lists the workspace's notion accounts with their sync state", async () => {
    const a = await seedWorkspace(handle!.db, `notion-list-${Date.now()}`);
    const auth = { userId: a.userId, workspaceId: a.workspaceId, role: "owner" as const };
    const account = await seedAccount(a.workspaceId, a.userId);
    await syncNotionAccount(auth, { externalAccountId: account.id, client: fakeClient([], {}) });
    const rows = await listNotionAccounts(auth);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(account.id);
    expect(rows[0]?.syncState).toBe("idle");
  });
});
