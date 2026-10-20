import { z } from "zod";
import type {
  ExtractionInput,
  ExtractionProvider,
  ExtractionResult,
} from "./provider";
import { normalizePageText } from "./cleanup";
import { MAX_UPLOAD_BYTES } from "@/lib/file-validation";

/*
 * Reducto, the second hosted extraction provider. Contract: the r-1 parse
 * API, per docs.reducto.ai/api-reference/{upload,parse}.md (checked
 * 2026-10-20). Two calls per extraction:
 *
 * 1. POST /upload, multipart field `file`; response { file_id }.
 * 2. POST /parse, JSON { input: "reducto://<file_id>" } with
 *    Authorization: Bearer <key>. Synchronous by default: the response
 *    carries result.chunks[].content. Page numbers are 1-indexed on each
 *    block's bbox.page; chunking mode "page" makes each chunk one page, so
 *    per-page spans come from the chunk order.
 *
 * A chunked result can arrive as { type: "url", url } when the payload
 * exceeds the HTTPS size limit; that is a failure here, not a second fetch —
 * a force_url_result setting is never requested, so it would mean a giant
 * single document better handled by splitting the source.
 *
 * The key stays server-env only. Responses are parsed with zod: provider
 * output is untrusted. REDUCTO_BASE_URL selects the host (default
 * https://platform.reducto.ai).
 */

const DEFAULT_BASE_URL = "https://platform.reducto.ai";
const DEFAULT_TIMEOUT_MS = 180_000;

const uploadResponse = z.object({ file_id: z.string().min(1) });

const parseBlock = z.object({
  bbox: z.object({ page: z.number().int().positive() }).nullish(),
});
const parseChunk = z.object({
  blocks: z.array(parseBlock).nullish(),
  content: z.string().nullish(),
});
const fullResult = z.object({
  type: z.literal("full"),
  chunks: z.array(parseChunk),
});
const parseResponse = z.object({
  result: z.union([fullResult, z.object({ type: z.literal("url") })]),
});

export function createReductoProvider(
  apiKey: string,
  baseUrl = process.env.REDUCTO_BASE_URL ?? DEFAULT_BASE_URL,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): ExtractionProvider {
  return {
    async extract(input: ExtractionInput): Promise<ExtractionResult> {
      const extractor = "reducto@hosted";
      // Defense-in-depth over intake's own guard (files/route.ts:57,
      // capture-url.ts:158): a future caller must not bypass it silently.
      if (input.bytes.byteLength > MAX_UPLOAD_BYTES) {
        return { ok: false, error: "The document is too large to read.", extractor };
      }

      const headers = { Authorization: `Bearer ${apiKey}` };
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const form = new FormData();
        form.append(
          "file",
          new Blob([new Uint8Array(input.bytes)], { type: input.mimeType }),
          input.filename,
        );
        const uploadRes = await fetch(`${baseUrl.replace(/\/$/, "")}/upload?extension=pdf`, {
          method: "POST",
          body: form,
          headers,
          signal: controller.signal,
        });
        if (!uploadRes.ok) {
          const detail = (await uploadRes.text()).slice(0, 300);
          return { ok: false, error: `reducto upload ${uploadRes.status}: ${detail}`, extractor };
        }
        const uploaded = uploadResponse.safeParse(await uploadRes.json());
        if (!uploaded.success) {
          return { ok: false, error: "reducto returned an unreadable upload response", extractor };
        }

        const parseRes = await fetch(`${baseUrl.replace(/\/$/, "")}/parse`, {
          method: "POST",
          headers: { ...headers, "Content-Type": "application/json" },
          body: JSON.stringify({
            input: `reducto://${uploaded.data.file_id}`,
            retrieval: { chunking: { chunk_mode: "page" } },
          }),
          signal: controller.signal,
        });
        if (!parseRes.ok) {
          const detail = (await parseRes.text()).slice(0, 300);
          return { ok: false, error: `reducto parse ${parseRes.status}: ${detail}`, extractor };
        }
        const parsed = parseResponse.safeParse(await parseRes.json());
        if (!parsed.success) {
          return { ok: false, error: "reducto returned an unreadable result", extractor };
        }
        if (parsed.data.result.type === "url") {
          return {
            ok: false,
            error: "reducto returned a URL reference instead of text; split the document and retry",
            extractor,
          };
        }

        // chunk_mode "page" makes each chunk one page, in reading order.
        const pages = parsed.data.result.chunks.map((chunk, index) => {
          const declared = chunk.blocks?.find((b) => b.bbox?.page != null)?.bbox?.page;
          return {
            page: declared ?? index + 1,
            text: normalizePageText(chunk.content ?? ""),
          };
        });
        const PAGE_BREAK = "\n\n";
        let text = "";
        // Pages are already normalizePageText'd above, so the span offsets
        // computed over the join match the returned text exactly. No second
        // normalize pass here: collapsing blank lines after the join would
        // shift every later span (cleanup.ts's own rule).
        const spans = pages.map((page, index) => {
          if (index > 0) text += PAGE_BREAK;
          const start = text.length;
          text += page.text;
          return { page: page.page, start, end: text.length };
        });
        if (!text.trim()) {
          return { ok: false, error: "reducto returned empty result text", extractor };
        }
        return {
          ok: true,
          text,
          spans,
          pageCount: pages.length,
          extractor,
        };
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        return { ok: false, error: `reducto unreachable: ${message}`, extractor };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
