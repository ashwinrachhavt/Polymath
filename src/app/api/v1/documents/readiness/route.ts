import { authedHandler } from "@/lib/auth";
import { requireRole } from "@/lib/auth/guards";
import { problemResponse } from "@/lib/problems";
import { listSources } from "@/domains/knowledge/source-readiness";
import { parseReadinessIds } from "@/domains/knowledge/readiness-batch";

/*
 * GET /api/v1/documents/readiness?ids=<uuid,uuid,…> — batch readiness for the
 * upload pollers (vault rows, notebook add-sources). A 201 from /api/v1/files
 * means the bytes landed; this is how the client learns what the ingest
 * pipeline did with them. Workspace-scoped through listSources: ids belonging
 * to another workspace simply come back absent.
 */
export const GET = authedHandler(async (auth, request) => {
  requireRole(auth, "member");
  const parsed = parseReadinessIds(new URL(request.url).searchParams.get("ids"));
  if (!parsed.ok) return problemResponse(422, "invalid_input", parsed.reason);
  const rows = await listSources(auth, { documentIds: parsed.ids, limit: 50 });
  return Response.json(
    {
      sources: rows.map(({ documentId, title, readiness, detail }) => ({ documentId, title, readiness, detail })),
    },
    { headers: { "Cache-Control": "private, no-store" } },
  );
});
