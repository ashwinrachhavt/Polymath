import { authedHandler } from "@/lib/auth";
import { requireRole } from "@/lib/auth/guards";
import { problemResponse } from "@/lib/problems";
import { extractDocument } from "@/domains/knowledge/extraction";

/*
 * POST /api/v1/documents/:documentId/extract — run (or reuse) the extraction
 * for one document. Idempotent by content hash: an already-extracted document
 * returns the stored text instead of re-running the provider.
 */
export const POST = authedHandler(async (auth, _request, ctx: { params: Promise<{ documentId: string }> }) => {
  requireRole(auth, "member");
  const { documentId } = await ctx.params;
  try {
    const result = await extractDocument(auth, { documentId });
    if (!result.ok) return problemResponse(422, "extraction_failed", result.error);
    return Response.json(result, { status: result.deduplicated ? 200 : 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("not found in workspace")) {
      return problemResponse(404, "not_found", "No such document in this workspace.");
    }
    if (message.includes("No extraction provider configured")) {
      return problemResponse(
        503,
        "provider_unconfigured",
        "No extraction provider is configured. Set DOCLING_SERVE_URL, REDUCTO_API_KEY or LLAMAPARSE_API_KEY, or OCR_PROVIDER=openrouter.",
      );
    }
    /*
     * Anything else from here down is the external provider's own failure —
     * a network drop, a 5xx, a malformed response. That is a bad gateway
     * with a problem body, never an unhandled 500 without one (RFC 9457).
     */
    console.error("document extraction failed", error);
    return problemResponse(502, "extraction_provider_failed", "The extraction provider failed. Try again.");
  }
});
