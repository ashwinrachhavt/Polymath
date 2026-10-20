import type {
  ExtractionInput,
  ExtractionProvider,
  ExtractionResult,
} from "./provider";
import { normalizeExtractedText } from "./cleanup";
import { MAX_UPLOAD_BYTES } from "@/lib/file-validation";

/*
 * docling-serve running in docker locally (the official docling-project image).
 * DOCLING_SERVE_URL points at it, e.g. http://localhost:5001 — the container's
 * v1 API takes multipart form data at /v1/convert/file and returns structured
 * JSON with markdown or text.
 *
 * Compliance note: this adapter is for local development only. The deployed
 * Vercel app cannot reach a developer's docker; there, the hosted adapter in
 * llamaparse.ts is resolved instead (see provider-resolution in the knowledge
 * domain). An unavailable local docling is a failed extraction, not a silent
 * empty result.
 */

const DEFAULT_TIMEOUT_MS = 120_000;

export function createDoclingDockerProvider(
  baseUrl: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): ExtractionProvider {
  return {
    async extract(input: ExtractionInput): Promise<ExtractionResult> {
      const extractor = "docling-serve@local";
      // Defense-in-depth: intake enforces this at the upload and URL-fetch
      // boundaries; a future caller must not bypass it silently.
      if (input.bytes.byteLength > MAX_UPLOAD_BYTES) {
        return {
          ok: false,
          error: "The document is too large to read.",
          extractor,
        };
      }
      const form = new FormData();
      form.append(
        "files",
        new Blob([new Uint8Array(input.bytes)], { type: input.mimeType }),
        input.filename,
      );

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await fetch(`${baseUrl.replace(/\/$/, "")}/v1/convert/file`, {
          method: "POST",
          body: form,
          signal: controller.signal,
        });
        if (!res.ok) {
          const detail = (await res.text()).slice(0, 300);
          return { ok: false, error: `docling-serve ${res.status}: ${detail}`, extractor };
        }
        const body = (await res.json()) as {
          document?: { md_content?: string; text_content?: string; page_count?: number };
        };
        const raw = body.document?.md_content ?? body.document?.text_content ?? "";
        // An empty conversion is a failed extraction, never an empty success:
        // the honest row names the failure and offers a retry.
        if (!raw.trim()) {
          return {
            ok: false,
            error: "docling-serve returned no readable text",
            extractor,
          };
        }
        const text = normalizeExtractedText(raw, "markdown");
        return {
          ok: true,
          text,
          // docling-serve's file endpoint does not return per-char offsets for
          // the whole document; a single full-text span is the honest shape
          // until a converter that yields offsets lands. Upgrade when needed.
          spans: text ? [{ page: 1, start: 0, end: text.length }] : [],
          pageCount: body.document?.page_count ?? null,
          extractor,
        };
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        return { ok: false, error: `docling-serve unreachable: ${message}`, extractor };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
