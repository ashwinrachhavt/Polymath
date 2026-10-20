import { authedHandler } from "@/lib/auth";
import { requireRole } from "@/lib/auth/guards";
import { problemResponse } from "@/lib/problems";
import { getDocumentText } from "@/domains/knowledge/file-preview";

/*
 * GET /api/v1/documents/:documentId/text - the full extracted text of the
 * document's current read, for the vault viewer's right pane. Workspace-scoped;
 * a document outside the workspace or with no succeeded read is a 404.
 */
export const GET = authedHandler(async (auth, _request, ctx: { params: Promise<{ documentId: string }> }) => {
  requireRole(auth, "viewer");
  const { documentId } = await ctx.params;
  if (!/^[0-9a-f-]{36}$/i.test(documentId)) return problemResponse(404, "not_found", "No such document in this workspace.");
  const text = await getDocumentText(auth, documentId);
  if (text === null) return problemResponse(404, "not_found", "This document has no read text yet.");
  return new Response(text, { headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "private, max-age=30" } });
});
