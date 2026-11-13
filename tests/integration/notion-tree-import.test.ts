import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { NotionClient, NotionPageRead, NotionSearchHit } from "@/integrations/notion/client";
import { makeTestDb, seedWorkspace } from "../helpers/test-workspace";

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

import { externalAccounts, syncCursors } from "@/domains/integrations/schema";
import { parseNotionPageId, summarizeNotionSync, syncNotionAccount } from "@/domains/integrations/notion";
import { notionSyncJob } from "@/domains/integrations/notion-job";
import { captures } from "@/domains/capture/schema";
import { documents, documentExtractions } from "@/domains/knowledge/schema";

beforeAll(() => {
  holder.db = handle?.db;
});
afterAll(async () => {
  vi.unstubAllEnvs();
  await handle?.client.end();
});
beforeEach(() => {
  vi.stubEnv("AXIOM_LOCAL_BLOB_DIR", `/tmp/axiom-blobs-${process.pid}`);
});

/*
 * A synthetic curriculum in the public shape of the owner's: a root hub, 33
 * technology pages beneath it, a deep nested talk library, a 200-block page
 * and an outside link on most pages. Nothing here is real content.
 */

type FakePage = {
  title: string;
  body: string;
  children?: string[];
  databases?: string[];
  unreadable?: string[];
  edited?: string;
  archived?: boolean;
};

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const urlOf = (pageId: string) => `https://www.notion.so/${pageId.replaceAll("-", "")}`;

function buildTree(): { pages: Map<string, FakePage>; root: string } {
  const pages = new Map<string, FakePage>();
  const root = id(1);
  const topics = Array.from({ length: 33 }, (_, i) => id(100 + i));
  topics.forEach((topicId, i) => {
    pages.set(topicId, {
      title: `Technology ${i + 1}`,
      body: `Notes on technology ${i + 1}.\n\n[Docs](https://docs.example.com/tech-${i % 20}) and [hub](${urlOf(root)}).\n`,
    });
  });
  // The deep talk library: a page nested four levels down, still discoverable.
  const talks = [id(200), id(201), id(202), id(203)];
  talks.forEach((talkId, i) =>
    pages.set(talkId, {
      title: `Talk level ${i + 1}`,
      body: `Talk ${i + 1}.\n`,
      children: talks[i + 1] ? [talks[i + 1]!] : [],
    }),
  );
  // The 200-block page: every line must reach the document.
  const long = Array.from({ length: 200 }, (_, i) => `Line ${i + 1} of the long page.`).join("\n\n");
  pages.set(id(300), { title: "Two hundred blocks", body: long + "\n" });
  pages.set(root, {
    title: "Study hub",
    body: "Start here.\n",
    children: [...topics, id(200), id(300)],
  });
  return { pages, root };
}

function fakeClient(
  pages: Map<string, FakePage>,
  options: { failRead?: Set<string>; calls?: string[] } = {},
): NotionClient {
  const hitOf = (pageId: string): NotionSearchHit => {
    const page = pages.get(pageId);
    if (!page) throw new Error("Notion GET failed (HTTP 404).");
    return {
      id: pageId,
      object: "page",
      title: page.title,
      url: urlOf(pageId),
      lastEditedTime: page.edited ?? "2026-11-01T10:00:00.000Z",
      parentType: "page",
      properties: {},
      archived: page.archived ?? false,
    };
  };
  const readPage = async (pageId: string): Promise<NotionPageRead> => {
    options.calls?.push(pageId);
    if (options.failRead?.has(pageId)) throw new Error("Notion blew up (HTTP 500).");
    const page = pages.get(pageId);
    if (!page) throw new Error("not found");
    return {
      markdown: page.body,
      childPageIds: page.children ?? [],
      databaseIds: page.databases ?? [],
      unreadable: page.unreadable ?? [],
    };
  };
  return {
    async searchEditedSince(since) {
      return [...pages.keys()].map(hitOf).filter((h) => !since || h.lastEditedTime > since);
    },
    async getPage(pageId) {
      return hitOf(pageId);
    },
    readPage,
    async getPageMarkdown(pageId) {
      return (await readPage(pageId)).markdown;
    },
    async queryDatabaseRows(databaseId) {
      return [...pages.entries()]
        .filter(([, p]) => p.title.startsWith(`row of ${databaseId}`))
        .map(([pageId]) => hitOf(pageId));
    },
  };
}

async function seed(label: string) {
  const a = await seedWorkspace(handle!.db, `${label}-${Date.now()}`);
  const auth = { userId: a.userId, workspaceId: a.workspaceId, role: "owner" as const };
  const [account] = await handle!.db
    .insert(externalAccounts)
    .values({
      workspaceId: a.workspaceId,
      provider: "notion",
      alias: `notion-${crypto.randomUUID().slice(0, 8)}`,
      createdBy: a.userId,
      updatedBy: a.userId,
      status: "active",
    })
    .returning();
  return { auth, account: account! };
}

const docsOf = (workspaceId: string) =>
  handle!.db.select().from(documents).where(eq(documents.workspaceId, workspaceId));

suite("notion tree import", { timeout: 120_000 }, () => {
  it("imports a root, 33 topics, a nested library and a 200-block page, then a second pass changes nothing", async () => {
    const { auth, account } = await seed("tree-basic");
    const { pages, root } = buildTree();
    const client = fakeClient(pages);

    const first = await syncNotionAccount(auth, { externalAccountId: account.id, client, rootPageId: urlOf(root) });
    // root + 33 topics + 4 nested talks + the long page
    expect(first.pages).toHaveLength(39);
    expect(first.created).toBe(39);
    expect(first.failed).toBe(0);
    expect(first.truncated).toBe(false);
    expect(first.links.captured).toBe(20); // 33 pages share 20 distinct outside links; the Notion link is not one
    expect(summarizeNotionSync(first)).toMatch(/^39 pages read: 39 new, 0 updated, 0 unchanged\./);

    const docs = await docsOf(auth.workspaceId);
    expect(docs).toHaveLength(39);
    // The deepest talk is discoverable, and every line of the long page is in its extraction.
    expect(docs.some((d) => d.title === "Talk level 4")).toBe(true);
    const long = docs.find((d) => d.title === "Two hundred blocks")!;
    const [extraction] = await handle!.db
      .select()
      .from(documentExtractions)
      .where(and(eq(documentExtractions.documentId, long.id), eq(documentExtractions.status, "succeeded")));
    expect(extraction?.text).toContain("Line 1 of the long page.");
    expect(extraction?.text).toContain("Line 200 of the long page.");

    const second = await syncNotionAccount(auth, { externalAccountId: account.id, client, rootPageId: urlOf(root) });
    expect(second.created + second.updated).toBe(0);
    expect(second.unchanged).toBe(39);
    expect(second.links).toMatchObject({ captured: 0, existing: 20 });
    expect(await docsOf(auth.workspaceId)).toHaveLength(39);
  });

  it("an edited page updates its own document; a moved page and a deleted page add no document", async () => {
    const { auth, account } = await seed("tree-changes");
    const { pages, root } = buildTree();
    await syncNotionAccount(auth, { externalAccountId: account.id, client: fakeClient(pages), rootPageId: root });
    const before = await docsOf(auth.workspaceId);

    pages.get(id(100))!.body = "Rewritten notes.\n";
    // Move a topic under the nested library, and delete another from the tree.
    const hub = pages.get(root)!;
    hub.children = hub.children!.filter((c) => c !== id(101) && c !== id(102));
    pages.get(id(203))!.children = [id(101)];
    pages.delete(id(102));

    const third = await syncNotionAccount(auth, {
      externalAccountId: account.id,
      client: fakeClient(pages),
      rootPageId: root,
    });
    expect(third.updated).toBe(1);
    expect(third.created).toBe(0);
    expect(third.failed).toBe(0);
    const after = await docsOf(auth.workspaceId);
    expect(after).toHaveLength(before.length);
    const edited = after.find((d) => d.sourceUrl === urlOf(id(100)))!;
    expect(edited.id).toBe(before.find((d) => d.sourceUrl === urlOf(id(100)))!.id);
    // The deleted page stays in the library with its history; Polymath never deletes on Notion's word.
    expect(after.some((d) => d.sourceUrl === urlOf(id(102)))).toBe(true);
  });

  it("a page that fails mid-walk is named, and the next pass imports it without duplicating anything", async () => {
    const { auth, account } = await seed("tree-retry");
    const { pages, root } = buildTree();
    const failing = new Set([id(110), id(205)]);
    pages.set(id(205), { title: "Unlucky", body: "x\n" });
    pages.get(root)!.children!.push(id(205));

    const broken = await syncNotionAccount(auth, {
      externalAccountId: account.id,
      client: fakeClient(pages, { failRead: failing }),
      rootPageId: root,
    });
    expect(broken.failed).toBe(2);
    expect(broken.created).toBe(38);
    const summary = summarizeNotionSync(broken);
    expect(summary).toContain("2 skipped: ");
    expect(summary).toContain("Technology 11");
    expect(summary).toContain("HTTP 500");
    const [cursor] = await handle!.db.select().from(syncCursors).where(eq(syncCursors.externalAccountId, account.id));
    expect(cursor!.state).toBe("partial");
    expect(cursor!.lastError).toContain("2 pages failed");

    const healed = await syncNotionAccount(auth, {
      externalAccountId: account.id,
      client: fakeClient(pages),
      rootPageId: root,
    });
    expect(healed.failed).toBe(0);
    expect(healed.created).toBe(2);
    expect(healed.unchanged).toBe(38);
    expect(await docsOf(auth.workspaceId)).toHaveLength(40);
    const [after] = await handle!.db.select().from(syncCursors).where(eq(syncCursors.externalAccountId, account.id));
    expect(after!.state).toBe("idle");
  });

  it("imports a page whose nested part could not be read, says so in the text and the summary, and fills in later", async () => {
    const { auth, account } = await seed("tree-partial");
    const { pages, root } = buildTree();
    pages.get(id(100))!.unreadable = [`${id(999)}: Notion GET failed (HTTP 403)`];
    const first = await syncNotionAccount(auth, {
      externalAccountId: account.id,
      client: fakeClient(pages),
      rootPageId: root,
    });
    expect(first.partial).toBe(1);
    expect(first.pages.find((p) => p.pageId === id(100))?.partial).toContain("HTTP 403");
    expect(summarizeNotionSync(first)).toContain("1 read only in part.");
    const doc = (await docsOf(auth.workspaceId)).find((d) => d.sourceUrl === urlOf(id(100)))!;
    const [extraction] = await handle!.db
      .select()
      .from(documentExtractions)
      .where(eq(documentExtractions.documentId, doc.id));
    expect(extraction?.text).toContain("Part of this page could not be read from Notion");

    // Access returns: the same page now reads whole and becomes version two of the same document.
    pages.get(id(100))!.unreadable = [];
    const second = await syncNotionAccount(auth, {
      externalAccountId: account.id,
      client: fakeClient(pages),
      rootPageId: root,
    });
    expect(second.updated).toBe(1);
    expect(second.partial).toBe(0);
  });

  it("a trashed page and a database's rows are handled; a database that will not open is named", async () => {
    const { auth, account } = await seed("tree-db");
    const { pages, root } = buildTree();
    pages.get(root)!.databases = ["db-ok", "db-bad"];
    pages.set("row-1", { title: "row of db-ok one", body: "Row one.\n" });
    pages.set("row-2", { title: "row of db-ok two", body: "Row two.\n" });
    pages.set(id(104), { ...pages.get(id(104))!, archived: true });
    const client = fakeClient(pages);
    const base = client.queryDatabaseRows.bind(client);
    client.queryDatabaseRows = async (databaseId) => {
      if (databaseId === "db-bad") throw new Error("Notion POST failed (HTTP 403).");
      return base(databaseId);
    };
    const result = await syncNotionAccount(auth, { externalAccountId: account.id, client, rootPageId: root });
    const titles = (await docsOf(auth.workspaceId)).map((d) => d.title);
    expect(titles).toEqual(expect.arrayContaining(["row of db-ok one", "row of db-ok two"]));
    expect(titles).not.toContain("Technology 5"); // the trashed page
    expect(result.failed).toBe(1);
    expect(result.pages.find((p) => p.outcome === "failed")?.title).toBe("A database Notion would not open");
  });

  it("outside links become one inbox capture each, never duplicated, and do not leak across workspaces", async () => {
    const mine = await seed("tree-links");
    const other = await seed("tree-links-other");
    const { pages, root } = buildTree();
    await syncNotionAccount(mine.auth, {
      externalAccountId: mine.account.id,
      client: fakeClient(pages),
      rootPageId: root,
    });
    const rows = await handle!.db
      .select()
      .from(captures)
      .where(and(eq(captures.workspaceId, mine.auth.workspaceId), eq(captures.source, "import")));
    expect(rows).toHaveLength(20);
    expect(rows.every((r) => r.url?.startsWith("https://docs.example.com/"))).toBe(true);
    expect(rows.some((r) => r.url?.includes("notion.so"))).toBe(false);
    const theirs = await handle!.db.select().from(captures).where(eq(captures.workspaceId, other.auth.workspaceId));
    expect(theirs).toHaveLength(0);
  });

  it("without a root, a failed page holds the watermark back so it and later edits are read again", async () => {
    const { auth, account } = await seed("tree-watermark");
    const pages = new Map<string, FakePage>([
      [id(1), { title: "Early", body: "a\n", edited: "2026-11-01T10:00:00.000Z" }],
      [id(2), { title: "Fails", body: "b\n", edited: "2026-11-02T10:00:00.000Z" }],
      [id(3), { title: "Late", body: "c\n", edited: "2026-11-03T10:00:00.000Z" }],
    ]);
    const first = await syncNotionAccount(auth, {
      externalAccountId: account.id,
      client: fakeClient(pages, { failRead: new Set([id(2)]) }),
    });
    expect(first.created).toBe(2);
    expect(first.failed).toBe(1);
    expect(first.watermark).toBe("2026-11-01T10:00:00.000Z");

    const calls: string[] = [];
    const second = await syncNotionAccount(auth, {
      externalAccountId: account.id,
      client: fakeClient(pages, { calls }),
    });
    expect(calls.sort()).toEqual([id(2), id(3)]);
    expect(second.created).toBe(1);
    expect(second.unchanged).toBe(1);
    expect(second.watermark).toBe("2026-11-03T10:00:00.000Z");
    expect(await docsOf(auth.workspaceId)).toHaveLength(3);
  });

  it("reports progress page by page, and a stop requested through it ends the pass without losing what was imported", async () => {
    const { auth, account } = await seed("tree-progress");
    const { pages, root } = buildTree();
    const seen: { done: number; total: number }[] = [];
    await expect(
      syncNotionAccount(auth, {
        externalAccountId: account.id,
        client: fakeClient(pages),
        rootPageId: root,
        progress: async (_step, counts) => {
          seen.push(counts);
          if (counts.done === 5) throw new Error("cancelled");
        },
      }),
    ).rejects.toThrow("cancelled");
    expect(seen.map((c) => c.done)).toEqual([1, 2, 3, 4, 5]);
    expect(seen.every((c) => c.total >= c.done)).toBe(true);
    expect(await docsOf(auth.workspaceId)).toHaveLength(5);
    const [cursor] = await handle!.db.select().from(syncCursors).where(eq(syncCursors.externalAccountId, account.id));
    expect(cursor!.state).toBe("failed");

    // Starting again finishes the rest and imports nothing twice.
    const rest = await syncNotionAccount(auth, {
      externalAccountId: account.id,
      client: fakeClient(pages),
      rootPageId: root,
    });
    expect(rest.unchanged).toBe(5);
    expect(rest.created).toBe(34);
    expect(await docsOf(auth.workspaceId)).toHaveLength(39);
  });

  it("refuses a root that is not a Notion page link and reads nothing", async () => {
    const { auth, account } = await seed("tree-badroot");
    await expect(
      syncNotionAccount(auth, {
        externalAccountId: account.id,
        client: fakeClient(new Map()),
        rootPageId: "not a link",
      }),
    ).rejects.toMatchObject({ code: "bad_root" });
  });
});

describe("notionSyncJob", () => {
  const accountId = "00000000-0000-4000-8000-0000000000aa";
  it("repeats its key within 15 seconds and for the same root, and differs after or for another root", () => {
    const t = new Date("2026-11-13T09:00:00.000Z");
    const first = notionSyncJob({ externalAccountId: accountId, rootPageId: urlOf(id(1)) }, t);
    expect(
      notionSyncJob({ externalAccountId: accountId, rootPageId: urlOf(id(1)) }, new Date(t.getTime() + 5_000))
        .idempotencyKey,
    ).toBe(first.idempotencyKey);
    expect(
      notionSyncJob({ externalAccountId: accountId, rootPageId: urlOf(id(1)) }, new Date(t.getTime() + 30_000))
        .idempotencyKey,
    ).not.toBe(first.idempotencyKey);
    expect(notionSyncJob({ externalAccountId: accountId, rootPageId: urlOf(id(2)) }, t).idempotencyKey).not.toBe(
      first.idempotencyKey,
    );
    expect(notionSyncJob({ externalAccountId: accountId }, t).idempotencyKey).toContain(":all:");
    expect(first.subject).toBe(`integration:${accountId}`);
  });
});

describe("parseNotionPageId", () => {
  it("reads the id out of a page link, a slugged link or a bare id", () => {
    const dashed = "4132e262-08a5-8159-941d-fed8d664d6a6";
    expect(parseNotionPageId("https://app.notion.com/p/4132e26208a58159941dfed8d664d6a6?pvs=204")).toBe(dashed);
    expect(parseNotionPageId("https://www.notion.so/Mastery-Sprint-4132e26208a58159941dfed8d664d6a6")).toBe(dashed);
    expect(parseNotionPageId(dashed.toUpperCase())).toBe(dashed);
    expect(parseNotionPageId("hello")).toBeNull();
  });
});
