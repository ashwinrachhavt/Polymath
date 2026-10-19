import { z } from "zod";
import { authedHandler } from "@/lib/auth";
import { requireRole } from "@/lib/auth/guards";
import { problemResponse } from "@/lib/problems";
import { searchWebForAgent, WEB_SEARCH_MAX_RESULTS } from "@/domains/knowledge/web-search";

/*
 * POST /api/v1/search — the workspace's web search API. The same normalized
 * results the Eve `web_search` tool returns, for app surfaces (and the owner
 * curled from a terminal). Read-only; members and above.
 */

const searchRequest = z.object({
  query: z.string().min(1).max(500),
  limit: z.number().int().min(1).max(WEB_SEARCH_MAX_RESULTS).optional(),
});

export const POST = authedHandler(async (auth, request) => {
  requireRole(auth, "member");
  const parsed = searchRequest.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return problemResponse(422, "invalid_input", `Give a query (1-500 chars) and optionally a limit (1-${WEB_SEARCH_MAX_RESULTS}).`);
  }
  const result = await searchWebForAgent(auth, parsed.data);
  if (!result.ok) {
    return problemResponse(502, "search_failed", result.error);
  }
  return Response.json(result);
});
