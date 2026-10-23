import { PDFDocument } from "pdf-lib";
import { z } from "zod";
import { normalizePageText } from "./cleanup";
import type {
  ExtractionInput,
  ExtractionProvider,
  ExtractionResult,
} from "./provider";

/*
 * Vision OCR through the workspace's existing OpenRouter key: the rescue rung
 * for documents the free readers cannot handle — scanned PDFs with no text
 * layer and image uploads (jpeg/png/webp). Contract: OpenRouter chat
 * completions multimodal input, per openrouter.ai/docs/features/multimodal/
 * pdfs and /images (checked 2026-10-23).
 *
 * A scanned PDF is split into single-page PDFs with pdf-lib (pure JS, no
 * native dependency, safe in a serverless bundle) and each page is sent as a
 * `file` content part with the file-parser engine pinned to "native". The pin
 * matters: without it OpenRouter silently falls back to the mistral-ocr
 * engine at $2 per 1,000 pages, while the default model below reads files
 * natively and charges input tokens only. Page-per-request keeps every span
 * page-exact — the citations UI opens a source on its page, so a guessed
 * page break would be a visible lie — and names the page a provider failed
 * on, matching the LlamaParse adapter's partial-is-failure rule.
 *
 * Default model google/gemini-2.5-flash-lite: natively reads file+image
 * input, $0.10 per 1M input / $0.40 per 1M output tokens, and Google counts
 * a PDF page as 258 tokens (ai.google.dev/gemini-api/docs/document-processing),
 * so a 30-page dense scan costs well under a cent. All three figures are
 * live-API/documentation rates as of 2026-10-23; OCR_MODEL swaps the model.
 *
 * This provider is metered and off by default: it runs only when the domain
 * resolver sees OCR_PROVIDER=openrouter. The key stays server-env only,
 * responses are parsed with zod, and provider error bodies are not retained —
 * status only, matching the generation seam.
 */

const DEFAULT_BASE_URL = "https://openrouter.ai/api/v1";
export const DEFAULT_OCR_MODEL = "google/gemini-2.5-flash-lite";
export const DEFAULT_OCR_MAX_PAGES = 30;
/*
 * Bounded for the platform the upload route runs on: extraction happens in
 * the post-response window of a Vercel function whose Hobby ceiling is 60 s,
 * so the default overall budget stays under it. OCR_TIMEOUT_MS raises the
 * budget where the function limit is higher (local has no such cap).
 */
const DEFAULT_TIMEOUT_MS = 50_000;
const PAGE_CONCURRENCY = 4;

const IMAGE_MIME: Record<string, string> = {
  "image/jpeg": "jpeg",
  "image/png": "png",
  "image/webp": "webp",
};

/*
 * The model's way to say the page held nothing readable; anything else it
 * returns is the page's text. A sentinel beats a blank string because the
 * difference between "blank page" and "empty response" is whether the read
 * happened at all.
 */
const UNREADABLE = "UNREADABLE";
const PROMPT =
  "Transcribe this document page exactly as written, in reading order, as plain markdown. " +
  "Preserve headings, lists and tables. Do not describe the page, summarize it, or add commentary. " +
  `If the page is blank or unreadable, reply with the single word ${UNREADABLE}.`;

const chatResponse = z.object({
  choices: z
    .array(z.object({ message: z.object({ content: z.string().nullish() }).optional() }))
    .min(1),
});

export type OpenRouterVisionOptions = {
  model?: string;
  baseUrl?: string;
  /** Overall budget across all page requests. */
  timeoutMs?: number;
  /** Hard page cap: the spend bound. Over the cap is a named failure, never a silent trim. */
  maxPages?: number;
};

export function createOpenRouterVisionProvider(
  apiKey: string,
  options: OpenRouterVisionOptions = {},
): ExtractionProvider {
  const model = options.model || DEFAULT_OCR_MODEL;
  const baseUrl = (options.baseUrl ?? process.env.OPENROUTER_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/$/, "");
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxPages = options.maxPages ?? DEFAULT_OCR_MAX_PAGES;
  const extractor = `openrouter-vision:${model}@hosted`;

  async function readPage(parts: Array<Record<string, unknown>>, signal: AbortSignal): Promise<string> {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        temperature: 0,
        messages: [{ role: "user", content: [{ type: "text", text: PROMPT }, ...parts] }],
        // The pin is the price control: "native" sends the page to the model
        // as-is; an unpinned request can route through the paid OCR engine.
        plugins: [{ id: "file-parser", pdf: { engine: "native" } }],
      }),
      signal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = chatResponse.safeParse(await response.json());
    if (!body.success) throw new Error("unreadable response");
    const text = body.data.choices[0]?.message?.content?.trim() ?? "";
    if (!text || text === UNREADABLE) throw new Error("page unreadable");
    return text;
  }

  return {
    async extract(input: ExtractionInput): Promise<ExtractionResult> {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const imageExt = IMAGE_MIME[input.mimeType];
        let pageParts: Array<Array<Record<string, unknown>>>;
        if (input.mimeType === "application/pdf") {
          let pages: Uint8Array[];
          try {
            pages = await splitPdfPages(input.bytes, maxPages);
          } catch (cause) {
            const message = cause instanceof Error ? cause.message : String(cause);
            return { ok: false, error: `The PDF could not be prepared for OCR: ${message}`, extractor };
          }
          pageParts = pages.map((page, index) => [
            {
              type: "file",
              file: {
                filename: `page-${index + 1}.pdf`,
                file_data: `data:application/pdf;base64,${Buffer.from(page).toString("base64")}`,
              },
            },
          ]);
        } else if (imageExt) {
          pageParts = [
            [
              {
                type: "image_url",
                image_url: {
                  url: `data:${input.mimeType};base64,${Buffer.from(input.bytes).toString("base64")}`,
                },
              },
            ],
          ];
        } else {
          return { ok: false, error: `openrouter vision does not read ${input.mimeType}`, extractor };
        }

        // Every page is attempted even after a failure: the verdict names all
        // the pages the provider could not read, not just the first.
        const outcomes: Array<{ text: string } | { error: string }> = await mapPool(pageParts, PAGE_CONCURRENCY, async (parts) => {
          try {
            return { text: await readPage(parts, controller.signal) };
          } catch (cause) {
            const message = cause instanceof Error ? cause.message : String(cause);
            return { error: controller.signal.aborted ? "timed out" : message };
          }
        });
        const failed = outcomes.flatMap((outcome, index) => ("error" in outcome ? [index + 1] : []));
        if (failed.length) {
          const detail = outcomes.find((o) => "error" in o);
          const reason = detail && "error" in detail ? `: ${detail.error}` : "";
          return {
            ok: false,
            error: `openrouter vision could not read page ${failed.join(", ")}${reason}`,
            extractor,
          };
        }

        const PAGE_BREAK = "\n\n";
        let text = "";
        const spans = outcomes.map((outcome, index) => {
          const pageText = normalizePageText("text" in outcome ? outcome.text : "");
          if (index > 0) text += PAGE_BREAK;
          const start = text.length;
          text += pageText;
          return { page: index + 1, start, end: text.length };
        });
        if (!text.trim()) {
          return { ok: false, error: "openrouter vision returned empty result text", extractor };
        }
        return { ok: true, text, spans, pageCount: outcomes.length, extractor };
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        return { ok: false, error: `openrouter vision unreachable: ${message}`, extractor };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/*
 * The env resolver the domain calls. Vision OCR is opt-in, never inferred
 * from a key's presence: reading a scan sends its pages to a metered model,
 * so the workspace turns it on (OCR_PROVIDER=openrouter) knowing the rate —
 * the same way it chose its hosted providers. OCR_MODEL and OCR_MAX_PAGES
 * override the defaults; OCR_PROVIDER unset or anything else stays off.
 */
export function openRouterVisionProviderFromEnv(
  env: Record<string, string | undefined>,
): ExtractionProvider | null {
  if (env.OCR_PROVIDER?.trim().toLowerCase() !== "openrouter") return null;
  const apiKey = env.OPENROUTER_API_KEY?.trim();
  if (!apiKey) return null;
  const parsedCap = Number(env.OCR_MAX_PAGES);
  return createOpenRouterVisionProvider(apiKey, {
    model: env.OCR_MODEL?.trim() || undefined,
    maxPages: Number.isInteger(parsedCap) && parsedCap > 0 ? parsedCap : undefined,
  });
}

/** One output per page, in page order; each page is its own serialized PDF. */
async function splitPdfPages(bytes: Uint8Array, maxPages: number): Promise<Uint8Array[]> {
  const source = await PDFDocument.load(new Uint8Array(bytes), { ignoreEncryption: true });
  const count = source.getPageCount();
  if (count > maxPages) {
    throw new Error(
      `${count} pages is over the OCR page limit of ${maxPages}; split the document or raise OCR_MAX_PAGES`,
    );
  }
  const pages: Uint8Array[] = [];
  for (let index = 0; index < count; index += 1) {
    const single = await PDFDocument.create();
    const [page] = await single.copyPages(source, [index]);
    single.addPage(page);
    pages.push(await single.save());
  }
  return pages;
}

/** Bounded-concurrency map: results keep input order regardless of finish order. */
async function mapPool<T, R>(items: T[], size: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (next < items.length) {
        const index = next;
        next += 1;
        out[index] = await fn(items[index]!);
      }
    }),
  );
  return out;
}
