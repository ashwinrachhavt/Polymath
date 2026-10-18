import type {
  ExtractionInput,
  ExtractionProvider,
  ExtractionResult,
} from "./provider";

/*
 * LlamaParse — the hosted free-tier extraction used where a local docling
 * docker is unreachable (Vercel deploys). Free tier: ~10K credits/mo at 1
 * credit/page on the Fast tier [verify the live number against
 * developers.llamaindex.ai/llamaparse/general/pricing before relying on the
 * bound — sources disagreed at plan time].
 *
 * LlamaParse's job API is async: POST the file, poll the job until done, then
 * fetch the result text. Both calls carry the Authorization: Bear <key> header;
 * the key stays server-env-only and never reaches a response body.
 */

const DEFAULT_TIMEOUT_MS = 180_000;
const POLL_INTERVAL_MS = 2_000;
const MAX_POLLS = 45;

export function createLlamaParseProvider(
  apiKey: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): ExtractionProvider {
  return {
    async extract(input: ExtractionInput): Promise<ExtractionResult> {
      const extractor = "llamaparse@hosted";
      const headers = { Authorization: `Bear ${apiKey}` };
      const started = Date.now();

      try {
        // 1. Upload — multipart form, language and fast tier pinned to keep
        // the free-credit spend predictable.
        const uploadForm = new FormData();
        uploadForm.append(
          "file",
          new Blob([new Uint8Array(input.bytes)], { type: input.mimeType }),
          input.filename,
        );
        uploadForm.append("language", "en");
        uploadForm.append("parse_mode", "fast");

        const upload = await fetch("https://api.cloud.llamaindex.ai/api/parsing/upload", {
          method: "POST",
          headers,
          body: uploadForm,
        });
        if (!upload.ok) {
          const detail = (await upload.text()).slice(0, 300);
          return { ok: false, error: `llamaparse upload ${upload.status}: ${detail}`, extractor };
        }
        const { id: jobId, polling_url: pollingUrl } = (await upload.json()) as {
          id: string;
          polling_url?: string;
        };
        if (!jobId) return { ok: false, error: "llamaparse upload returned no job id", extractor };

        // 2. Poll — bounded: MAX_POLLS x POLL_INTERVAL_MS, plus the overall
        // timeout, so a stuck job cannot hold the request forever.
        const resultUrl = pollingUrl ?? `https://api.cloud.llamaindex.ai/api/parsing/job/${jobId}`;
        let status = "";
        for (let poll = 0; poll < MAX_POLLS; poll++) {
          if (Date.now() - started > timeoutMs) {
            return { ok: false, error: "llamaparse job timed out", extractor };
          }
          await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
          const job = await fetch(resultUrl, { headers });
          if (!job.ok) continue;
          const state = (await job.json()) as { status?: string };
          status = state.status ?? "";
          if (status === "SUCCESS" || status === "ERROR" || status === "PARTIAL") break;
        }
        if (status !== "SUCCESS" && status !== "PARTIAL") {
          return { ok: false, error: `llamaparse job ended ${status || "without a status"}`, extractor };
        }

        // 3. Fetch the markdown result.
        const text = await fetch(
          `https://api.cloud.llamaindex.ai/api/parsing/job/${jobId}/result/md`,
          { headers },
        ).then((r) => (r.ok ? r.text() : ""));
        if (!text) return { ok: false, error: "llamaparse returned empty result text", extractor };

        return {
          ok: true,
          text,
          // Same honest single-span shape as the docling adapter.
          spans: [{ page: 1, start: 0, end: text.length }],
          pageCount: null,
          extractor,
        };
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        return { ok: false, error: `llamaparse unreachable: ${message}`, extractor };
      }
    },
  };
}
