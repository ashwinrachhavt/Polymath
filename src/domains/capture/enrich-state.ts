import { z } from "zod";

/*
 * What an Enrich request left on a capture, stored at raw_payload.enrichment
 * beside the immutable original. Pure, so the inbox detail pane reads the
 * same shape the server writes. `failures` counts settled failed runs; it
 * names the next request's dispatch key, so a retry is a new outbox row while
 * a second click on a pending request collides with the first.
 */

const failures = z.number().int().min(0);

const captureEnrichmentSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("pending"), requestedAt: z.string(), failures }),
  z.object({ status: z.literal("failed"), error: z.string(), failedAt: z.string(), failures }),
  z.object({
    status: z.literal("done"),
    summary: z.string(),
    keyPoints: z.array(z.string()),
    suggestedNotebookId: z.string().nullable(),
    /** The notebook's title when it was suggested; the link goes by id. */
    suggestedNotebookTitle: z.string().nullable(),
    enrichedAt: z.string(),
    failures,
  }),
]);

export type CaptureEnrichment = z.infer<typeof captureEnrichmentSchema>;

/** The stored enrichment, or null when none was ever requested (or the stored value is unreadable). */
export function readEnrichment(rawPayload: unknown): CaptureEnrichment | null {
  if (typeof rawPayload !== "object" || rawPayload === null || Array.isArray(rawPayload)) return null;
  const parsed = captureEnrichmentSchema.safeParse((rawPayload as { enrichment?: unknown }).enrichment);
  return parsed.success ? parsed.data : null;
}

/** The first request is `enrich:<captureId>`; each retry after a failure gets its own key. */
export function enrichDispatchKey(captureId: string, failureCount: number): string {
  return failureCount === 0 ? `enrich:${captureId}` : `enrich:${captureId}:retry-${failureCount}`;
}

export const ENRICH_PENDING_LABEL = "Reading the page and writing a summary. It appears here when ready.";
