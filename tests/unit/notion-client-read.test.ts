import { describe, expect, it } from "vitest";
import { composioNotionClient } from "@/integrations/notion/client";
import { externalLinks } from "@/integrations/notion/markdown";

/*
 * The reader against a fake Composio proxy. Synthetic blocks only: the tests
 * pin how a page is read to the end, not what any real page says.
 */

const paragraph = (id: string, text: string, extra: Record<string, unknown> = {}) => ({
  id,
  type: "paragraph",
  paragraph: { rich_text: [{ plain_text: text }] },
  ...extra,
});

type Reply = { status?: number; body?: unknown };

/** A proxy that answers each Notion endpoint from a script and records the calls. */
function proxy(script: (endpoint: string, query: Record<string, string>, attempt: number) => Reply) {
  const attempts = new Map<string, number>();
  const calls: string[] = [];
  const fetchImpl = (async (_url: unknown, init: { body: string }) => {
    const request = JSON.parse(init.body) as {
      endpoint: string;
      parameters: { name: string; value: string; type: string }[];
    };
    const query = Object.fromEntries(
      request.parameters.filter((p) => p.type === "query").map((p) => [p.name, p.value]),
    );
    const key = request.endpoint + JSON.stringify(query);
    const attempt = (attempts.get(key) ?? 0) + 1;
    attempts.set(key, attempt);
    calls.push(key);
    const reply = script(request.endpoint, query, attempt);
    return new Response(JSON.stringify(reply.body ?? {}), { status: reply.status ?? 200 });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const client = (fetchImpl: typeof fetch) =>
  composioNotionClient("ca_test", { COMPOSIO_API_KEY: "k" } as unknown as NodeJS.ProcessEnv, fetchImpl, {
    retryDelayMs: 1,
  });

describe("composioNotionClient.readPage", () => {
  it("reads a 250-block page to the end of every list", async () => {
    const all = Array.from({ length: 250 }, (_, i) => paragraph(`b${i}`, `line ${i}`));
    const { fetchImpl } = proxy((endpoint, query) => {
      if (endpoint !== "/v1/blocks/page/children") return { status: 404 };
      const from = Number(query.start_cursor ?? 0);
      const results = all.slice(from, from + 100);
      const more = from + 100 < all.length;
      return { body: { results, has_more: more, next_cursor: more ? String(from + 100) : null } };
    });
    const read = await client(fetchImpl).readPage("page");
    expect(read.unreadable).toEqual([]);
    expect(read.markdown).toContain("line 0");
    expect(read.markdown).toContain("line 99");
    expect(read.markdown).toContain("line 100");
    expect(read.markdown).toContain("line 249");
  });

  it("names a nested list it could not read and keeps the rest", async () => {
    const { fetchImpl } = proxy((endpoint) => {
      if (endpoint === "/v1/blocks/page/children") {
        return {
          body: {
            results: [
              paragraph("a", "before"),
              { id: "t", type: "toggle", has_children: true, toggle: { rich_text: [{ plain_text: "Details" }] } },
              paragraph("c", "after"),
            ],
          },
        };
      }
      return { status: 403 };
    });
    const read = await client(fetchImpl).readPage("page");
    expect(read.markdown).toContain("before");
    expect(read.markdown).toContain("after");
    expect(read.unreadable).toHaveLength(1);
    expect(read.unreadable[0]).toContain("t: ");
    expect(read.unreadable[0]).toContain("HTTP 403");
  });

  it("fails the read when the page's own block list cannot be read", async () => {
    const { fetchImpl } = proxy(() => ({ status: 403 }));
    await expect(client(fetchImpl).readPage("page")).rejects.toThrow("HTTP 403");
  });

  it("does not read a child page's blocks into its parent, and reports where the tree goes", async () => {
    const { fetchImpl, calls } = proxy((endpoint) => {
      if (endpoint === "/v1/blocks/page/children") {
        return {
          body: {
            results: [
              { id: "child-1", type: "child_page", has_children: true, child_page: { title: "Child" } },
              { id: "db-1", type: "child_database", has_children: true, child_database: { title: "Rows" } },
              { id: "l", type: "link_to_page", link_to_page: { type: "page_id", page_id: "linked-1" } },
              { id: "bm", type: "bookmark", bookmark: { url: "https://example.com/a" } },
            ],
          },
        };
      }
      return { status: 500 };
    });
    const read = await client(fetchImpl).readPage("page");
    expect(read.childPageIds).toEqual(["child-1", "linked-1"]);
    expect(read.databaseIds).toEqual(["db-1"]);
    expect(calls.some((c) => c.includes("child-1"))).toBe(false);
    expect(externalLinks(read.markdown)).toEqual(["https://example.com/a"]);
  });

  it("stops at the block limit and says so", async () => {
    // A list that always claims another page must end at the 10,000-block limit, partial and named.
    const { fetchImpl } = proxy((endpoint, query) => {
      if (endpoint !== "/v1/blocks/page/children") return { status: 404 };
      const n = Number(query.start_cursor ?? 0);
      const results = Array.from({ length: 100 }, (_, i) => paragraph(`b${n}-${i}`, "x"));
      return { body: { results, has_more: true, next_cursor: String(n + 1) } };
    });
    const read = await client(fetchImpl).readPage("page");
    expect(read.unreadable).toEqual(["limit: stopped after 10000 blocks"]);
    expect(read.markdown).toContain("x");
  });
});

describe("composioNotionClient retries", () => {
  it("repeats a read that fails with a transient status", async () => {
    const { fetchImpl, calls } = proxy((_e, _q, attempt) =>
      attempt < 3 ? { status: 429 } : { body: { results: [paragraph("a", "ok")] } },
    );
    const read = await client(fetchImpl).readPage("page");
    expect(read.markdown).toContain("ok");
    expect(calls).toHaveLength(3);
  });

  it("gives up after the attempt limit and does not retry a client error", async () => {
    const always = proxy(() => ({ status: 503 }));
    await expect(client(always.fetchImpl).readPage("page")).rejects.toThrow("HTTP 503");
    expect(always.calls).toHaveLength(4);
    const missing = proxy(() => ({ status: 404 }));
    await expect(client(missing.fetchImpl).getPage("gone")).rejects.toThrow("HTTP 404");
    expect(missing.calls).toHaveLength(1);
  });
});

describe("externalLinks", () => {
  it("keeps outside links once each and leaves Notion links and file URLs out", () => {
    const md = [
      "[Docs](https://modelcontextprotocol.io/) and [again](https://modelcontextprotocol.io/)",
      "[A page](https://www.notion.so/Spec-1234567890abcdef1234567890abcdef)",
      "[Hub](https://app.notion.com/p/1234567890abcdef1234567890abcdef)",
      "[image: https://prod-files.example.com/signed?X=1]",
      "[Repo](https://github.com/pgvector/pgvector)",
    ].join("\n");
    expect(externalLinks(md)).toEqual(["https://modelcontextprotocol.io/", "https://github.com/pgvector/pgvector"]);
  });
});
