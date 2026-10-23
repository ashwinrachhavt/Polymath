import { describe, expect, it } from "vitest";
import { readNotionPage, searchNotion } from "@/domains/integrations/reads/notion";
import { TOOL_SCHEMAS } from "@/domains/integrations/tool-manifest";
import { fixtureTransport } from "../helpers/fixture-transport";

const ACCOUNT = "ca_test";
const PAGE_ID = "1234567890abcdef1234567890abcdef";

const searchBody = {
  results: [
    {
      id: PAGE_ID,
      object: "page",
      url: "https://www.notion.so/Spec-1234567890abcdef1234567890abcdef",
      last_edited_time: "2026-10-20T00:00:00.000Z",
      parent: { type: "workspace" },
      properties: { Name: { type: "title", title: [{ plain_text: "Product Spec" }] } },
    },
    { id: "db1", object: "database", title: [{ plain_text: "Roadmap" }], url: "https://www.notion.so/db1", last_edited_time: "2026-10-19T00:00:00.000Z" },
  ],
};

describe("notion reads", () => {
  it("searches pages and databases and summarises titles", async () => {
    const transport = fixtureTransport([{ method: "POST", endpointPrefix: "https://api.notion.com/v1/search", status: 200, body: searchBody }]);
    const result = await searchNotion(transport, { connectedAccountId: ACCOUNT, query: "spec", limit: 10 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.items).toHaveLength(2);
    expect(result.items[0]).toMatchObject({ object: "page", title: "Product Spec", parentType: "workspace" });
    expect(result.items[1]).toMatchObject({ object: "database", title: "Roadmap" });
  });

  it("fails closed on a malformed search body", async () => {
    const transport = fixtureTransport([{ method: "POST", endpointPrefix: "https://api.notion.com/v1/search", status: 200, body: 42 }]);
    const result = await searchNotion(transport, { connectedAccountId: ACCOUNT, query: "spec", limit: 10 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("malformed_response");
  });

  it("reads a page as clipped markdown", async () => {
    const transport = fixtureTransport([
      { method: "GET", endpointPrefix: `https://api.notion.com/v1/pages/${PAGE_ID}`, status: 200, body: { id: PAGE_ID, url: "u", last_edited_time: "t", properties: { Name: { type: "title", title: [{ plain_text: "Spec" }] } } } },
      {
        method: "GET",
        endpointPrefix: `https://api.notion.com/v1/blocks/${PAGE_ID}/children`,
        status: 200,
        body: { results: [{ id: "b1", type: "paragraph", paragraph: { rich_text: [{ plain_text: "hello notion" }] } }], has_more: false },
      },
    ]);
    const result = await readNotionPage(transport, { connectedAccountId: ACCOUNT, pageId: PAGE_ID });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.item.title).toBe("Spec");
    expect(result.markdown).toContain("hello notion");
    expect(result.truncated).toBe(false);
  });

  it("surfaces a provider failure with its status", async () => {
    const transport = fixtureTransport([{ method: "POST", endpointPrefix: "https://api.notion.com/v1/search", status: 401, body: {} }]);
    const result = await searchNotion(transport, { connectedAccountId: ACCOUNT, query: "spec", limit: 10 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("provider_error");
  });
});

describe("notion tool schemas", () => {
  it("accepts dashed and bare page ids and rejects anything else", () => {
    expect(TOOL_SCHEMAS.notion_read_page.safeParse({ pageId: PAGE_ID }).success).toBe(true);
    expect(TOOL_SCHEMAS.notion_read_page.safeParse({ pageId: "12345678-90ab-cdef-1234-567890abcdef" }).success).toBe(true);
    expect(TOOL_SCHEMAS.notion_read_page.safeParse({ pageId: "../../etc" }).success).toBe(false);
    expect(TOOL_SCHEMAS.notion_search.safeParse({ query: "" }).success).toBe(false);
  });
});

describe("notion read safety rails", () => {
  it("sends a fixed endpoint and body shape - only query and page_size carry caller values", async () => {
    const captured: import("@/domains/integrations/transport").PostReadRequest[] = [];
    const transport = fixtureTransport(
      [{ method: "POST", endpointPrefix: "https://api.notion.com/v1/search", status: 200, body: { results: [] } }],
      captured,
    );
    const hostile = 'x"}}POST https://evil.example DELETE';
    await searchNotion(transport, { connectedAccountId: ACCOUNT, query: hostile, limit: 5 });
    expect(captured).toHaveLength(1);
    const request = captured[0] as import("@/domains/integrations/transport").PostReadRequest;
    expect(request.endpoint).toBe("https://api.notion.com/v1/search");
    expect(request.connectedAccountId).toBe(ACCOUNT);
    // The hostile string travels as an inert body field; the shape never changes.
    expect(Object.keys(request.body).sort()).toEqual(["page_size", "query", "sort"]);
    expect(request.body.query).toBe(hostile);
    expect(request.body.page_size).toBe(5);
    expect(request.headers).toEqual({ "Notion-Version": "2022-06-28" });
  });

  it("passes the connected account through verbatim and takes the page id only from arguments", async () => {
    const captured: import("@/domains/integrations/transport").TransportRequest[] = [];
    const transport = fixtureTransport(
      [
        { method: "GET", endpointPrefix: `https://api.notion.com/v1/pages/${PAGE_ID}`, status: 200, body: { id: PAGE_ID, properties: {} } },
        { method: "GET", endpointPrefix: `https://api.notion.com/v1/blocks/${PAGE_ID}/children`, status: 200, body: { results: [] } },
      ],
      captured,
    );
    await readNotionPage(transport, { connectedAccountId: ACCOUNT, pageId: PAGE_ID });
    expect(captured.map((r) => r.connectedAccountId)).toEqual([ACCOUNT, ACCOUNT]);
    for (const request of captured) {
      expect(request.endpoint.startsWith("https://api.notion.com/")).toBe(true);
      expect(request.method).toBe("GET");
    }
  });

  it("clips an over-long page and marks it truncated", async () => {
    const big = "x".repeat(9000);
    const transport = fixtureTransport([
      { method: "GET", endpointPrefix: `https://api.notion.com/v1/pages/${PAGE_ID}`, status: 200, body: { id: PAGE_ID, properties: {} } },
      {
        method: "GET",
        endpointPrefix: `https://api.notion.com/v1/blocks/${PAGE_ID}/children`,
        status: 200,
        body: { results: [{ id: "b1", type: "paragraph", paragraph: { rich_text: [{ plain_text: big }] } }], has_more: false },
      },
    ]);
    const result = await readNotionPage(transport, { connectedAccountId: ACCOUNT, pageId: PAGE_ID });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.markdown.length).toBeLessThanOrEqual(4100);
    expect(result.truncated).toBe(true);
  });

  it("marks a page with more blocks as truncated", async () => {
    const transport = fixtureTransport([
      { method: "GET", endpointPrefix: `https://api.notion.com/v1/pages/${PAGE_ID}`, status: 200, body: { id: PAGE_ID, properties: {} } },
      { method: "GET", endpointPrefix: `https://api.notion.com/v1/blocks/${PAGE_ID}/children`, status: 200, body: { results: [], has_more: true } },
    ]);
    const result = await readNotionPage(transport, { connectedAccountId: ACCOUNT, pageId: PAGE_ID });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.truncated).toBe(true);
  });
});
