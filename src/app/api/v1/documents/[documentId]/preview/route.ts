import { authedHandler } from "@/lib/auth";
import { requireRole } from "@/lib/auth/guards";
import { problemResponse } from "@/lib/problems";
import { getDocumentPreview } from "@/domains/knowledge/file-preview";

/*
 * GET /api/v1/documents/:documentId/preview - the Files preview pane's read:
 * review composition, a short excerpt, and the document's activity trail.
 * Workspace-scoped; a document outside the workspace is a 404.
 */
export const GET = authedHandler(async (auth, _request, ctx: { params: Promise<{ documentId: string }> }) => {
  requireRole(auth, "viewer");
  const { documentId } = await ctx.params;
  if (!/^[0-9a-f-]{36}$/i.test(documentId)) return problemResponse(404, "not_found", "No such document in this workspace.");
  const preview = await getDocumentPreview(auth, documentId);
  if (!preview) return problemResponse(404, "not_found", "No such document in this workspace.");
  return Response.json(preview, { headers: { "Cache-Control": "private, max-age=15" } });
});
