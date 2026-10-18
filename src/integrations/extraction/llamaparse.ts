import { z } from "zod";
import type {
  ExtractionInput,
  ExtractionProvider,
  ExtractionResult,
} from "./provider";

/*
 * LlamaParse, the hosted extraction used where a local docling docker is
 * unreachable (Vercel deploys). Contract: the v2 parse API, per
 * developers.llamaindex.ai/llamaparse/parse/guides/api-reference (checked
 * 2026-10-17; v1 /api/v1/parsing/* still exists but new features are v2-only).
 *
 * 1. POST /api/v2/parse/upload, multipart: `file` plus a `configuration` JSON
 *    string. `tier` and `version` are both required; tier "fast" keeps the
 *    free-credit spend predictable.
 * 2. GET /api/v2/parse/{id}: the job is nested, status under `job.status`
 *    (PENDING, RUNNING, COMPLETED, FAILED, CANCELLED).
 * 3. GET /api/v2/parse/{id}?expand=markdown: JSON, `markdown.pages[]` with
 *    page_number, markdown, and success per page.
 *
 * Every call carries Authorization: Bearer <key>; the key stays server-env
 * only. Responses are parsed with zod: provider output is untrusted. Keys are
 * regional (an NA key fails against the EU host); LLAMAPARSE_BASE_URL selects
 * the host.
 */

const DEFAULT_BASE_URL = "https://api.cloud.llamaindex.ai";
const DEFAULT_TIMEOUT_MS = 180_000;
const POLL_INTERVAL_MS = 2_000;
const MAX_POLLS = 45;
const PAGE_BREAK = "\n\n";

const createdJob = z.object({ id: z.string().min(1) });
const jobState = z.object({
  job: z.object({
    status: z.enum(["PENDING", "RUNNING", "COMPLETED", "FAILED", "CANCELLED"]),
    error_message: z.string().nullish(),
  }),
});
const markdownResult = z.object({
  markdown: z.object({
    pages: z.array(
      z.object({
        page_number: z.number().int(),
        success: z.boolean(),
        markdown: z.string().nullish(),
      }),
    ),
  }),
});

export function createLlamaParseProvider(
  apiKey: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  baseUrl = process.env.LLAMAPARSE_BASE_URL ?? DEFAULT_BASE_URL,
): ExtractionProvider {
  const api = `${baseUrl.replace(/\/$/, "")}/api/v2/parse`;
  return {
    async extract(input: ExtractionInput): Promise<ExtractionResult> {
      const extractor = "llamaparse-v2@hosted";
      const headers = { Authorization: `Bearer ${apiKey}` };
      const started = Date.now();

      try {
        const form = new FormData();
        form.append("file", new Blob([new Uint8Array(input.bytes)], { type: input.mimeType }), input.filename);
        form.append("configuration", JSON.stringify({ tier: "fast", version: "latest" }));
        const upload = await fetch(`${api}/upload`, { method: "POST", headers, body: form });
        if (!upload.ok) {
          const detail = (await upload.text()).slice(0, 300);
          return { ok: false, error: `llamaparse upload ${upload.status}: ${detail}`, extractor };
        }
        const created = createdJob.safeParse(await upload.json());
        if (!created.success) return { ok: false, error: "llamaparse upload returned no job id", extractor };
        const jobUrl = `${api}/${encodeURIComponent(created.data.id)}`;

        // Bounded: MAX_POLLS x POLL_INTERVAL_MS, plus the overall timeout, so
        // a stuck job cannot hold the request forever.
        let status = "";
        let jobError: string | null | undefined;
        for (let poll = 0; poll < MAX_POLLS; poll++) {
          if (Date.now() - started > timeoutMs) {
            return { ok: false, error: "llamaparse job timed out", extractor };
          }
          await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
          const job = await fetch(jobUrl, { headers });
          if (!job.ok) continue;
          const state = jobState.safeParse(await job.json());
          if (!state.success) continue;
          status = state.data.job.status;
          jobError = state.data.job.error_message;
          if (status === "COMPLETED" || status === "FAILED" || status === "CANCELLED") break;
        }
        if (status !== "COMPLETED") {
          const reason = jobError ? `: ${jobError.slice(0, 200)}` : "";
          return { ok: false, error: `llamaparse job ended ${status || "without a status"}${reason}`, extractor };
        }

        const resultResponse = await fetch(`${jobUrl}?expand=markdown`, { headers });
        if (!resultResponse.ok) {
          return { ok: false, error: `llamaparse result ${resultResponse.status}`, extractor };
        }
        const result = markdownResult.safeParse(await resultResponse.json());
        if (!result.success) return { ok: false, error: "llamaparse returned an unreadable result", extractor };

        // A page the provider failed to read is a partial result; partial is
        // reported as a failure rather than filed as the whole document.
        const pages = [...result.data.markdown.pages].sort((a, b) => a.page_number - b.page_number);
        const failed = pages.filter((p) => !p.success).map((p) => p.page_number);
        if (failed.length) {
          return { ok: false, error: `llamaparse could not read page ${failed.join(", ")}`, extractor };
        }

        let text = "";
        const spans = pages.map((page, index) => {
          if (index > 0) text += PAGE_BREAK;
          const start = text.length;
          text += page.markdown ?? "";
          return { page: page.page_number, start, end: text.length };
        });
        if (!text.trim()) return { ok: false, error: "llamaparse returned empty result text", extractor };

        // Markdown carries no structured field list (that is LlamaExtract, a
        // separate product), so fields stay undefined; the knowledge domain's
        // rules read fields from the text.
        return { ok: true, text, spans, pageCount: pages.length, extractor };
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        return { ok: false, error: `llamaparse unreachable: ${message}`, extractor };
      }
    },
  };
}
