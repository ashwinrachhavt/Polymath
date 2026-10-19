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
};

export interface NotionClient {
  /** Every shared page and database edited after `since` (ISO), oldest first. */
  searchEditedSince(since: string | null): Promise<NotionSearchHit[]>;
  /** One page's blocks as markdown, children resolved. */
  getPageMarkdown(pageId: string): Promise<string>;
  /** A database's rows as search hits (each row is a page). */
  queryDatabaseRows(databaseId: string): Promise<NotionSearchHit[]>;
}

const COMPOSIO_PROXY_URL = "https://backend.composio.dev/api/v3/tools/execute/proxy";

type ProxyFetch = typeof fetch;

/** One call to the Notion API through Composio's proxy: the token never touches Polymath. */
async function notionViaProxy(
  fetchImpl: ProxyFetch,
  apiKey: string,
  connectedAccountId: string,
  path: string,
  init: { method: string; body?: unknown; query?: Record<string, string> },
): Promise<unknown> {
  // Verified against Composio's v3 reference (docs.composio.dev
  // /reference/v3/api-reference/tools/postToolsExecuteProxy, 2026-10-18).
  const parameters = [
    { name: "Notion-Version", value: NOTION_VERSION, type: "header" },
    ...Object.entries(init.query ?? {}).map(([name, value]) => ({ name, value, type: "query" })),
  ];
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
  if (!res.ok) throw new Error(`Notion read failed (HTTP ${res.status}).`);
  return res.json();
}

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
      return ((v.select as { name?: string } | null)?.name) ?? "";
    case "multi_select":
      return ((v.multi_select as { name?: string }[]) ?? []).map((s) => s.name).join(", ");
    case "date":
      return ((v.date as { start?: string } | null)?.start) ?? "";
    case "number":
      return String(v.number ?? "");
    case "checkbox":
      return v.checkbox ? "yes" : "no";
    case "url":
    case "email":
    case "phone_number":
      return (v[v.type] as string) ?? "";
    case "status":
      return ((v.status as { name?: string } | null)?.name) ?? "";
    case "people":
      return ((v.people as { name?: string }[]) ?? []).map((p) => p.name ?? "").filter(Boolean).join(", ");
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
  };
}

const NOTION_VERSION = "2022-06-28";

export function composioNotionClient(
  connectedAccountId: string,
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: ProxyFetch = fetch,
): NotionClient {
  const apiKey = env.COMPOSIO_API_KEY;
  if (!apiKey) throw new Error("COMPOSIO_API_KEY is not set.");
  const call = (path: string, init: { method: string; body?: unknown; query?: Record<string, string> }) =>
    notionViaProxy(fetchImpl, apiKey, connectedAccountId, path, init);

  async function collectBlocks(pageId: string): Promise<Map<string, import("./markdown").NotionBlock[] | null>> {
    const byParent = new Map<string, import("./markdown").NotionBlock[]>();
    async function walk(id: string) {
      let cursor: string | undefined;
      do {
        const data = (await call(`/v1/blocks/${id}/children`, {
          method: "GET",
          query: { page_size: "100", ...(cursor ? { start_cursor: cursor } : {}) },
        })) as {
          results?: import("./markdown").NotionBlock[];
          next_cursor?: string | null;
          has_more?: boolean;
        };
        const results = data.results ?? [];
        byParent.set(id, results);
        for (const block of results) if (block.has_children) await walk(block.id);
        cursor = data.has_more ? (data.next_cursor ?? undefined) : undefined;
      } while (cursor);
    }
    await walk(pageId);
    return byParent;
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
    async getPageMarkdown(pageId) {
      const { blocksToMarkdown } = await import("./markdown");
      const byParent = await collectBlocks(pageId);
      const roots = byParent.get(pageId) ?? [];
      return blocksToMarkdown(roots, (block) => byParent.get(block.id) ?? null);
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

export { NOTION_VERSION };
