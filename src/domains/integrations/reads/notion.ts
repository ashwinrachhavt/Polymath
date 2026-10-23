import { z } from "zod";
import type { Transport, TransportResult } from "@/domains/integrations/transport";
import type { ReadFailure } from "./github";
import { blocksToMarkdown, type NotionBlock } from "@/integrations/notion/markdown";

/*
 * Notion reads. Search is POST-shaped, so it travels the transport's
 * constant-body seam: the endpoint, the sort and the body shape are fixed
 * here; the only caller values are the query text and the page size, both
 * validated. Page reads are plain GETs. Every title and block is untrusted
 * provider content - summarised, never executed.
 */

const API = "https://api.notion.com";
const NOTION_VERSION = "2022-06-28";
const MAX_PAGE_BLOCKS = 50;
const MAX_MARKDOWN_CHARS = 4000;

// Notion ids arrive as 32 hex characters, dashed or not; URLs carry both forms.
export const notionPageId = z
  .string()
  .regex(/^(?:[0-9a-fA-F]{32}|[0-9a-fA-F]{8}-(?:[0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12})$/, "Use a Notion page id (32 hex characters, dashes optional).");

const hitSchema = z.object({
  id: z.string(),
  object: z.union([z.literal("page"), z.literal("database")]).catch("page"),
  url: z.string().optional(),
  last_edited_time: z.string().optional(),
  parent: z.object({ type: z.string().optional() }).passthrough().optional(),
  properties: z.record(z.string(), z.unknown()).optional(),
  title: z.unknown().optional(),
});

const searchSchema = z.object({
  results: z.array(hitSchema.passthrough()).optional(),
});

const pageSchema = z.object({
  id: z.string(),
  url: z.string().optional(),
  last_edited_time: z.string().optional(),
  properties: z.record(z.string(), z.unknown()).optional(),
});

const blocksSchema = z.object({
  results: z.array(z.unknown()).optional(),
  has_more: z.boolean().optional(),
});

function richTextPlain(parts: unknown): string {
  if (!Array.isArray(parts)) return "";
  return (parts as { plain_text?: string }[]).map((part) => part.plain_text ?? "").join("");
}

function titleOf(hit: { properties?: Record<string, unknown>; title?: unknown }): string {
  if (Array.isArray(hit.title)) return richTextPlain(hit.title) || "Untitled";
  for (const value of Object.values(hit.properties ?? {})) {
    const candidate = value as { type?: string; title?: unknown };
    if (candidate?.type === "title") return richTextPlain(candidate.title) || "Untitled";
  }
  return "Untitled";
}

function malformed(what: string): ReadFailure {
  return { ok: false, code: "malformed_response", message: `Notion returned a ${what} response this app does not recognise.` };
}

function notConfigured(): ReadFailure {
  return { ok: false, code: "not_configured", message: "This deployment cannot reach Notion yet." };
}

export type NotionSearchItem = {
  id: string;
  object: "page" | "database";
  title: string;
  url: string | null;
  lastEditedTime: string | null;
  parentType: string;
};

function toItem(raw: z.infer<typeof hitSchema>): NotionSearchItem {
  return {
    id: raw.id,
    object: raw.object,
    title: titleOf(raw),
    url: raw.url ?? null,
    lastEditedTime: raw.last_edited_time ?? null,
    parentType: raw.parent?.type ?? "workspace",
  };
}

async function postSearch(
  transport: Transport,
  request: { connectedAccountId: string; body: Record<string, unknown> },
): Promise<TransportResult> {
  if (!transport.postRead) return { ok: false, code: "not_configured", message: "This deployment cannot reach Notion yet." };
  return transport.postRead({
    connectedAccountId: request.connectedAccountId,
    endpoint: `${API}/v1/search`,
    body: request.body,
    headers: { "Notion-Version": NOTION_VERSION },
  });
}

export async function searchNotion(
  transport: Transport,
  input: { connectedAccountId: string; query: string; limit: number },
): Promise<{ ok: true; items: NotionSearchItem[] } | ReadFailure> {
  const result = await postSearch(transport, {
    connectedAccountId: input.connectedAccountId,
    body: {
      query: input.query,
      page_size: input.limit,
      sort: { direction: "descending", timestamp: "last_edited_time" },
    },
  });
  if (!result.ok) return result.code === "not_configured" ? notConfigured() : { ok: false, code: "provider_error", message: result.message };
  const parsed = searchSchema.safeParse(result.data);
  if (!parsed.success) return malformed("search");
  return { ok: true, items: (parsed.data.results ?? []).map(toItem) };
}

export async function readNotionPage(
  transport: Transport,
  input: { connectedAccountId: string; pageId: string },
): Promise<
  | { ok: true; item: { id: string; title: string; url: string | null; lastEditedTime: string | null }; markdown: string; truncated: boolean }
  | ReadFailure
> {
  const id = input.pageId.replaceAll("-", "");
  const pageResult = await transport.read({
    connectedAccountId: input.connectedAccountId,
    endpoint: `${API}/v1/pages/${id}`,
    method: "GET",
    headers: { "Notion-Version": NOTION_VERSION },
  });
  if (!pageResult.ok) return pageResult.code === "not_configured" ? notConfigured() : { ok: false, code: "provider_error", message: pageResult.message };
  const page = pageSchema.safeParse(pageResult.data);
  if (!page.success) return malformed("page");

  const blocksResult = await transport.read({
    connectedAccountId: input.connectedAccountId,
    endpoint: `${API}/v1/blocks/${id}/children`,
    method: "GET",
    query: { page_size: String(MAX_PAGE_BLOCKS) },
    headers: { "Notion-Version": NOTION_VERSION },
  });
  if (!blocksResult.ok) {
    return blocksResult.code === "not_configured" ? notConfigured() : { ok: false, code: "provider_error", message: blocksResult.message };
  }
  const blocks = blocksSchema.safeParse(blocksResult.data);
  if (!blocks.success) return malformed("blocks");

  // Root blocks only: a page read answers "what does this page say" without
  // walking the whole tree; the importer owns deep sync.
  const markdown = blocksToMarkdown((blocks.data.results ?? []) as NotionBlock[], () => null);
  const clipped = markdown.length > MAX_MARKDOWN_CHARS ? `${markdown.slice(0, MAX_MARKDOWN_CHARS)}…` : markdown;
  return {
    ok: true,
    item: {
      id: page.data.id,
      title: titleOf(page.data),
      url: page.data.url ?? null,
      lastEditedTime: page.data.last_edited_time ?? null,
    },
    markdown: clipped,
    truncated: markdown.length > MAX_MARKDOWN_CHARS || (blocks.data.has_more ?? false),
  };
}
