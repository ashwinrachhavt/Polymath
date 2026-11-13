/*
 * The Notion read surface the importer needs, behind one interface. The real
 * adapter reaches Notion through Composio's proxy endpoint — Polymath stores the
 * Composio connected-account id, never an OAuth token (integrations domain
 * design). Tests plug in a fake.
 */

export type NotionSearchHit = {
  id: string;
  object: "page" | "database";
  title: string;
  url: string;
  lastEditedTime: string;
  parentType: string;
  /** Database-row pages: their property values as plain strings. */
  properties?: Record<string, string>;
  /** In the trash: a tree walk skips it. */
  archived?: boolean;
};

/**
 * One page, fully read. `unreadable` names every part Notion would not give
 * (a nested block that errored, a page past the safety limits); the markdown
 * holds the rest, so the caller can import honestly instead of failing whole.
 */
export type NotionPageRead = {
  markdown: string;
  /** Pages nested under this one, and pages it links to by a block, in order. */
  childPageIds: string[];
  /** Databases embedded in this page; their rows are pages of this tree. */
  databaseIds: string[];
  unreadable: string[];
};

export interface NotionClient {
  /** Every shared page and database edited after `since` (ISO), oldest first. */
  searchEditedSince(since: string | null): Promise<NotionSearchHit[]>;
  /** One page's metadata, for a walk that starts from a page the person chose. */
  getPage(pageId: string): Promise<NotionSearchHit>;
  /** One page's blocks read to the end of every list, as markdown plus where the tree goes next. */
  readPage(pageId: string): Promise<NotionPageRead>;
  /** One page's blocks as markdown, children resolved. */
  getPageMarkdown(pageId: string): Promise<string>;
  /** A database's rows as search hits (each row is a page). */
  queryDatabaseRows(databaseId: string): Promise<NotionSearchHit[]>;
}

/**
 * The write surface, kept separate from the read client on purpose: nothing
 * that only imports has any reason to hold a type that can append to a page.
 * Only `executeNotionPageProposal` takes one.
 */
export interface NotionWriteClient {
  /** Appends markdown as paragraph/bullet blocks to the end of an existing page. Returns the page id. */
  appendMarkdown(pageId: string, markdown: string): Promise<{ pageId: string; blocksAdded: number }>;
  /** Creates a page with markdown as its body. Resolves the parent by id and kind. */
  createPage(input: {
    parentId: string;
    parentType: "page" | "database";
    title: string;
    markdown: string;
  }): Promise<{ pageId: string; url: string; blocksAdded: number }>;
}

const COMPOSIO_PROXY_URL = "https://backend.composio.dev/api/v3/tools/execute/proxy";

type ProxyFetch = typeof fetch;

/** One call to the Notion API through Composio's proxy: the token never touches Polymath. */
async function notionViaProxy(
  fetchImpl: ProxyFetch,
  apiKey: string,
  connectedAccountId: string,
  path: string,
  init: { method: string; body?: unknown; query?: Record<string, string>; retry?: { delayMs: number } },
): Promise<unknown> {
  // Verified against Composio's v3 reference (docs.composio.dev
  // /reference/v3/api-reference/tools/postToolsExecuteProxy, 2026-10-18).
  const parameters = [
    { name: "Notion-Version", value: NOTION_VERSION, type: "header" },
    ...Object.entries(init.query ?? {}).map(([name, value]) => ({ name, value, type: "query" })),
  ];
  // Only a read may be repeated: replaying an append after an ambiguous
  // answer would write twice.
  const attempts = init.retry ? READ_ATTEMPTS : 1;
  for (let attempt = 1; ; attempt += 1) {
    const res = await fetchImpl(COMPOSIO_PROXY_URL, {
      method: "POST",
      headers: { "x-api-key": apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({
        connected_account_id: connectedAccountId,
        endpoint: path,
        method: init.method,
        ...(init.body ? { body: init.body } : {}),
        parameters,
      }),
    });
    if (res.ok) return res.json();
    const transient = res.status === 429 || res.status >= 500;
    if (!transient || attempt >= attempts)
      throw new Error(`Notion ${init.method} ${path} failed (HTTP ${res.status}).`);
    await new Promise((resolve) => setTimeout(resolve, init.retry!.delayMs * 2 ** (attempt - 1)));
  }
}

const READ_ATTEMPTS = 4;

function richTextPlain(parts: unknown): string {
  if (!Array.isArray(parts)) return "";
  return (parts as { plain_text?: string }[]).map((p) => p.plain_text ?? "").join("");
}

function titleOf(hit: { properties?: Record<string, unknown>; title?: unknown }): string {
  if (Array.isArray(hit.title)) return richTextPlain(hit.title) || "Untitled";
  for (const value of Object.values(hit.properties ?? {})) {
    const v = value as { type?: string; title?: unknown };
    if (v?.type === "title") return richTextPlain(v.title) || "Untitled";
  }
  return "Untitled";
}

function propertyText(value: unknown): string {
  const v = value as Record<string, unknown> & { type?: string };
  if (!v?.type) return "";
  switch (v.type) {
    case "title":
    case "rich_text":
      return richTextPlain(v[v.type]);
    case "select":
      return (v.select as { name?: string } | null)?.name ?? "";
    case "multi_select":
      return ((v.multi_select as { name?: string }[]) ?? []).map((s) => s.name).join(", ");
    case "date":
      return (v.date as { start?: string } | null)?.start ?? "";
    case "number":
      return String(v.number ?? "");
    case "checkbox":
      return v.checkbox ? "yes" : "no";
    case "url":
    case "email":
    case "phone_number":
      return (v[v.type] as string) ?? "";
    case "status":
      return (v.status as { name?: string } | null)?.name ?? "";
    case "people":
      return ((v.people as { name?: string }[]) ?? [])
        .map((p) => p.name ?? "")
        .filter(Boolean)
        .join(", ");
    default:
      return "";
  }
}

function toHit(raw: Record<string, unknown>): NotionSearchHit {
  const properties: Record<string, string> = {};
  for (const [key, value] of Object.entries((raw.properties as Record<string, unknown>) ?? {})) {
    const text = propertyText(value);
    if (text) properties[key] = text;
  }
  const parent = (raw.parent as { type?: string }) ?? {};
  return {
    id: String(raw.id),
    object: raw.object === "database" ? "database" : "page",
    title: titleOf(raw as { properties?: Record<string, unknown>; title?: unknown }),
    url: String(raw.url ?? ""),
    lastEditedTime: String(raw.last_edited_time ?? ""),
    parentType: parent.type ?? "workspace",
    properties,
    archived: raw.archived === true || raw.in_trash === true,
  };
}

const NOTION_VERSION = "2022-06-28";

/**
 * The write half of the Notion client, over the same Composio proxy as the
 * reader. A page is appended to in chunks of 100 blocks (Notion's per-request
 * cap); each chunk that lands is reported so a failure mid-page leaves a
 * partial effect the caller can see rather than a silent success.
 */
export function composioNotionWriteClient(
  connectedAccountId: string,
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: ProxyFetch = fetch,
): NotionWriteClient {
  const apiKey = env.COMPOSIO_API_KEY;
  if (!apiKey) throw new Error("COMPOSIO_API_KEY is not set.");
  const call = (path: string, init: { method: string; body?: unknown; query?: Record<string, string> }) =>
    notionViaProxy(fetchImpl, apiKey, connectedAccountId, path, init);

  return {
    async appendMarkdown(pageId, markdown) {
      const { markdownToBlocks, chunkBlocks } = await import("./blocks");
      const chunks = chunkBlocks(markdownToBlocks(markdown));
      if (chunks.length === 0) return { pageId, blocksAdded: 0 };
      let added = 0;
      for (const children of chunks) {
        await call(`/v1/blocks/${pageId}/children`, { method: "PATCH", body: { children } });
        added += children.length;
      }
      return { pageId, blocksAdded: added };
    },
    async createPage(input) {
      const { markdownToBlocks, chunkBlocks } = await import("./blocks");
      const chunks = chunkBlocks(markdownToBlocks(input.markdown));
      // Only the first chunk can be sent with the create call; the rest are
      // appended afterwards, which is why the body is chunked up front.
      const [first = [], ...rest] = chunks;
      const created = (await call("/v1/pages", {
        method: "POST",
        body: {
          parent: input.parentType === "database" ? { database_id: input.parentId } : { page_id: input.parentId },
          properties:
            input.parentType === "database"
              ? { title: { title: [{ type: "text", text: { content: input.title } }] } }
              : { title: { title: [{ type: "text", text: { content: input.title } }] } },
          children: first,
        },
      })) as { id?: string; url?: string };
      const pageId = String(created.id ?? "");
      if (!pageId) throw new Error("Notion did not return a page id.");
      let added = first.length;
      for (const children of rest) {
        await call(`/v1/blocks/${pageId}/children`, { method: "PATCH", body: { children } });
        added += children.length;
      }
      return { pageId, url: String(created.url ?? ""), blocksAdded: added };
    },
  };
}

/** Read limits: a page past either is imported as far as it was read, and says so. */
const MAX_BLOCKS_PER_PAGE = 10_000;
const MAX_BLOCK_DEPTH = 12;

export function composioNotionClient(
  connectedAccountId: string,
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: ProxyFetch = fetch,
  options: { retryDelayMs?: number } = {},
): NotionClient {
  const apiKey = env.COMPOSIO_API_KEY;
  if (!apiKey) throw new Error("COMPOSIO_API_KEY is not set.");
  const retry = { delayMs: options.retryDelayMs ?? 500 };
  const call = (path: string, init: { method: string; body?: unknown; query?: Record<string, string> }) =>
    notionViaProxy(fetchImpl, apiKey, connectedAccountId, path, { ...init, retry });

  /**
   * Every block under a page, to the end of every list. A failure under the
   * page's own list fails the read; a failure deeper down is recorded and the
   * rest is kept. A child page or database is a boundary: it is its own page.
   */
  async function collectBlocks(pageId: string) {
    const byParent = new Map<string, import("./markdown").NotionBlock[]>();
    const unreadable: string[] = [];
    let total = 0;
    const noteLimit = () => {
      if (!unreadable.some((entry) => entry.startsWith("limit:")))
        unreadable.push(`limit: stopped after ${MAX_BLOCKS_PER_PAGE} blocks`);
    };
    async function walk(id: string, depth: number): Promise<void> {
      const blocks: import("./markdown").NotionBlock[] = [];
      let cursor: string | undefined;
      try {
        do {
          const data = (await call(`/v1/blocks/${id}/children`, {
            method: "GET",
            query: { page_size: "100", ...(cursor ? { start_cursor: cursor } : {}) },
          })) as {
            results?: import("./markdown").NotionBlock[];
            next_cursor?: string | null;
            has_more?: boolean;
          };
          blocks.push(...(data.results ?? []));
          cursor = data.has_more ? (data.next_cursor ?? undefined) : undefined;
          if (cursor && total + blocks.length >= MAX_BLOCKS_PER_PAGE) {
            noteLimit();
            break;
          }
        } while (cursor);
      } catch (cause) {
        if (id === pageId) throw cause;
        unreadable.push(`${id}: ${cause instanceof Error ? cause.message : "read failed"}`);
      }
      byParent.set(id, blocks);
      total += blocks.length;
      for (const block of blocks) {
        if (!block.has_children || block.type === "child_page" || block.type === "child_database") continue;
        if (total >= MAX_BLOCKS_PER_PAGE) {
          noteLimit();
          return;
        }
        if (depth >= MAX_BLOCK_DEPTH) {
          unreadable.push(`${block.id}: nested more than ${MAX_BLOCK_DEPTH} levels deep`);
          continue;
        }
        await walk(block.id, depth + 1);
      }
    }
    await walk(pageId, 0);
    return { byParent, unreadable };
  }

  async function readPage(pageId: string): Promise<NotionPageRead> {
    const { blocksToMarkdown } = await import("./markdown");
    const { byParent, unreadable } = await collectBlocks(pageId);
    const childPageIds: string[] = [];
    const databaseIds: string[] = [];
    for (const blocks of byParent.values()) {
      for (const block of blocks) {
        if (block.type === "child_page") childPageIds.push(block.id);
        else if (block.type === "child_database") databaseIds.push(block.id);
        else if (block.type === "link_to_page") {
          const target = block.link_to_page as { type?: string; page_id?: string; database_id?: string } | undefined;
          if (target?.page_id) childPageIds.push(target.page_id);
          else if (target?.database_id) databaseIds.push(target.database_id);
        }
      }
    }
    const roots = byParent.get(pageId) ?? [];
    return {
      markdown: blocksToMarkdown(roots, (block) => byParent.get(block.id) ?? null),
      childPageIds,
      databaseIds,
      unreadable,
    };
  }

  return {
    async searchEditedSince(since) {
      const hits: NotionSearchHit[] = [];
      let cursor: string | undefined;
      do {
        const data = (await call("/v1/search", {
          method: "POST",
          body: {
            page_size: 100,
            ...(cursor ? { start_cursor: cursor } : {}),
            sort: { direction: "ascending", timestamp: "last_edited_time" },
          },
        })) as { results?: Record<string, unknown>[]; next_cursor?: string | null; has_more?: boolean };
        for (const raw of data.results ?? []) {
          const hit = toHit(raw);
          if (since && hit.lastEditedTime && hit.lastEditedTime <= since) continue;
          hits.push(hit);
        }
        cursor = data.has_more ? (data.next_cursor ?? undefined) : undefined;
      } while (cursor);
      return hits;
    },
    async getPage(pageId) {
      return toHit((await call(`/v1/pages/${pageId}`, { method: "GET" })) as Record<string, unknown>);
    },
    readPage,
    async getPageMarkdown(pageId) {
      return (await readPage(pageId)).markdown;
    },
    async queryDatabaseRows(databaseId) {
      const rows: NotionSearchHit[] = [];
      let cursor: string | undefined;
      do {
        const data = (await call(`/v1/databases/${databaseId}/query`, {
          method: "POST",
          body: { page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) },
        })) as { results?: Record<string, unknown>[]; next_cursor?: string | null; has_more?: boolean };
        for (const raw of data.results ?? []) rows.push(toHit(raw));
        cursor = data.has_more ? (data.next_cursor ?? undefined) : undefined;
      } while (cursor);
      return rows;
    },
  };
}
