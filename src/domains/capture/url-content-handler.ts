import { eq } from "drizzle-orm";
import type { ClaimedOutboxEvent, OutboxHandler } from "@/domains/audit/outbox";
import { scrapeToMarkdown } from "@/integrations/firecrawl/client";
import { fetchTranscript } from "@/integrations/youtube/transcript";
import { assertPublicUrl } from "@/domains/knowledge/web-fetch";
import { db } from "@/lib/db";
import {
  EnrichmentLeaseLostError,
  RELEASE,
  acquireEnrichmentLease,
  ownedUpdate,
  releaseEnrichmentLease,
} from "./enrichment-lease";
import { classifyFetchOutcome } from "./fetch-outcome";
import { captures } from "./schema";

/*
 * Fill a URL capture with the page's content. Websites go through Firecrawl
 * (markdown, main content only); YouTube addresses go through the transcript
 * API, which is what the knowledge ingest uses. The capture row keeps its
 * original rawPayload; the fetch writes `fetchedText` and `fetchOutcome` beside
 * it and the state moves to `classifying`, where the enrichment ladder picks
 * up `workingText` (the fetch for a page or an address, the selection
 * otherwise).
 *
 * `text` is only filled for a url-reference, whose `text` is null until the
 * page is read - that is what makes a bare address searchable and
 * convertible. A selection and a companion page grab brought their own words;
 * the fetch never replaces them.
 *
 * A fetch that fails records a real outcome (`error-page`, `empty`, or
 * `provider-unavailable`) and a reason, and the event completes: a dead
 * address would fail the same way on every retry. The person sees "Could not
 * be read". There is no retry command yet: pasting the URL again is refused
 * as a duplicate and enqueues nothing (ASH-318), so a failed capture
 * continues as an address-only capture.
 *
 * The URL was captured by a person, not supplied by a model, but it still
 * goes through assertPublicUrl: a pasted internal address must not become a
 * server-side fetch target.
 */

export const urlContentRequestedHandler: OutboxHandler = async (event: ClaimedOutboxEvent) => {
  const raw = event.payload ?? {};
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(`capture.url_content_requested has a malformed payload (${typeof raw}); redeploy the producer`);
  }
  const captureId =
    typeof (raw as { captureId?: unknown }).captureId === "string" ? (raw as { captureId: string }).captureId : null;
  const url = typeof (raw as { url?: unknown }).url === "string" ? (raw as { url: string }).url : null;
  if (!captureId || !url) throw new Error("capture.url_content_requested is missing captureId or url");

  const [capture] = await db.select().from(captures).where(eq(captures.id, captureId)).limit(1);
  if (!capture || capture.workspaceId !== event.workspaceId) return;
  // Only a capture still waiting for its page is fetched; a converted or
  // enriched capture does not need its reading text. "classifying" after a
  // fetch carries fetched text (or, for a bare address, the text the fetch
  // wrote), so a re-run returns early; "classifying" with neither is an
  // address-only capture left mid-classification, or unparked, and still
  // needs its page.
  const needsPage =
    capture.processingState === "unprocessed" ||
    (capture.processingState === "classifying" && !capture.text && !capture.fetchedText);
  if (!needsPage) return;
  // Parked (ASH-305): no new fetch while set aside. Unpark re-queues this.
  if (capture.parkedAt) return;

  // One fetch per capture at a time (ASH-305): the same fenced lease as
  // enrichment, so an unpark re-queue racing a claimed fetch waits instead of
  // scraping twice, and enrichment waits for the fetched text.
  const token = await acquireEnrichmentLease(event, capture);
  if (!token) return;
  try {
    const videoId = parseVideoIdLoose(url);
    const fetched = videoId ? await fetchTranscriptText(url) : await scrapePage(url);

    if (fetched.outcome !== "acquired") {
      await ownedUpdate(token, captureId, {
        fetchOutcome: fetched.outcome,
        failureReason: fetched.reason,
        updatedAt: new Date(),
        ...RELEASE,
      });
      return;
    }
    // ASH-318: the fetch fills the reading text and hands the capture to
    // enrichment (state "classifying" = fetched, awaiting classification), it
    // does not finish it: enrichment classifies the fetched page, and its own
    // waiting for this event means neither stage can drop the other's work.
    await ownedUpdate(token, captureId, {
      fetchedText: fetched.text,
      fetchOutcome: "acquired",
      // A bare address has no text of its own; the page's reading becomes it.
      ...(capture.captureMode === "url-reference" ? { text: fetched.text } : {}),
      processingState: "classifying",
      failureReason: null,
      updatedAt: new Date(),
      ...RELEASE,
    });
  } catch (cause) {
    if (cause instanceof EnrichmentLeaseLostError) return;
    await releaseEnrichmentLease(token, captureId);
    throw cause;
  }
};

function parseVideoIdLoose(url: string): string | null {
  if (!/youtube\.com|youtu\.be/i.test(url)) return null;
  const match = url.match(/(?:v=|youtu\.be\/)([A-Za-z0-9_-]{11})/);
  return match ? match[1] : null;
}

/** What a fetch produced: text only when the page was actually read. */
type FetchedContent =
  | { outcome: "acquired"; text: string }
  | { outcome: "error-page" | "access-denied" | "empty" | "provider-unavailable"; reason: string };

async function fetchTranscriptText(url: string): Promise<FetchedContent> {
  const result = await fetchTranscript(url);
  if (!result.ok) {
    // A video with no captions is not a broken fetch; it is a page with
    // nothing to read. Everything else is the provider's failure.
    const outcome = result.error.includes("no captions") ? "empty" : "provider-unavailable";
    return { outcome, reason: result.error };
  }
  return { outcome: "acquired", text: result.text };
}

async function scrapePage(url: string): Promise<FetchedContent> {
  const parsed = assertPublicUrl(url);
  if (!parsed) {
    return { outcome: "access-denied", reason: "That address could not be read: it is not a public web address." };
  }
  let page: Awaited<ReturnType<typeof scrapeToMarkdown>>;
  try {
    page = await scrapeToMarkdown(parsed.toString());
  } catch (cause) {
    return {
      outcome: "provider-unavailable",
      reason: `The page could not be read: ${cause instanceof Error ? cause.message : "the fetch failed"}.`,
    };
  }
  const { outcome, text } = classifyFetchOutcome(page);
  if (outcome === "acquired" && text !== null) return { outcome: "acquired", text };
  if (outcome === "empty") {
    return { outcome: "empty", reason: "The page could not be read: the site returned no readable text." };
  }
  // Firecrawl still delivers the body it rendered for a failed page; a 404
  // page with readable text is an error page, never acquired content.
  const detail = page.error ?? `the site answered with status ${page.statusCode}`;
  return { outcome: "error-page", reason: `The page could not be read: ${detail}.` };
}
