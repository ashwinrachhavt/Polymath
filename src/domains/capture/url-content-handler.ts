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
import { captures } from "./schema";

/*
 * Fill a URL capture with the page's content. Websites go through Firecrawl
 * (markdown, main content only); YouTube addresses go through the transcript
 * API, which is what the knowledge ingest uses. The capture row keeps its
 * original rawPayload; `text` gains the fetched reading text and the state
 * moves to `classifying`, where the enrichment ladder picks it up.
 *
 * A fetch that fails is recorded as a failure reason on the capture and the
 * event completes — a dead address would fail the same way on every retry.
 * The person sees "Could not be read". There is no retry command yet: pasting
 * the URL again is refused as a duplicate and enqueues nothing (ASH-318 tracks
 * an explicit retry), so a failed capture continues as an address-only capture.
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
  // enriched capture does not need its reading text.
  // "classifying" with text is the post-fetch handoff, so any existing fetched
  // text blocks a refetch; "classifying" without text (an address-only capture
  // left mid-classification, or unparked) still needs its page.
  const needsPage =
    capture.processingState === "unprocessed" || (capture.processingState === "classifying" && !capture.text);
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
    const content = videoId ? await fetchTranscript(url) : await scrapePage(url);

    if (!content.ok) {
      await ownedUpdate(token, captureId, { failureReason: content.error, updatedAt: new Date(), ...RELEASE });
      return;
    }
    // ASH-318: the fetch fills the text and hands the capture to enrichment
    // (state "classifying" = fetched, awaiting classification), it does not
    // finish it: enrichment classifies the fetched page, and its own waiting
    // for this event means neither stage can drop the other's work.
    await ownedUpdate(token, captureId, {
      text: content.text,
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

async function scrapePage(url: string): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
  const parsed = assertPublicUrl(url);
  if (!parsed) return { ok: false, error: "That address could not be read: it is not a public web address." };
  try {
    const page = await scrapeToMarkdown(parsed.toString());
    // Firecrawl reports the HTTP status in `error` while still delivering the
    // body it rendered; a 404 page with readable text is still worth showing.
    // Only an empty body is a real failure.
    if (!page.markdown.trim()) {
      return { ok: false, error: "The page could not be read: the site returned no readable text." };
    }
    const title = page.title ? `${page.title}\n\n` : "";
    return { ok: true, text: `${title}${page.markdown}`.slice(0, 200_000) };
  } catch (cause) {
    return {
      ok: false,
      error: `The page could not be read: ${cause instanceof Error ? cause.message : "the fetch failed"}.`,
    };
  }
}
