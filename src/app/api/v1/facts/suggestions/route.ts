import { z } from "zod";
import { authedHandler } from "@/lib/auth";
import { requireRole } from "@/lib/auth/guards";
import { withCors } from "@/lib/cors";
import { problemResponse } from "@/lib/problems";
import { activeSuggestions } from "@/domains/facts/queries";

/*
 * GET /api/v1/facts/suggestions — the job-drafted facts for FactPoll's extra
 * pool. Global content: the deck is shared, so any authenticated member of a
 * workspace may read it, and the wait surfaces that consume it merge it with
 * the curated deck client-side.
 */

const suggestionsResponse = z.object({
  facts: z.array(
    z.object({
      id: z.string().uuid(),
      topic: z.enum(["science", "philosophy"]),
      tags: z.array(z.string()),
      text: z.string(),
    }),
  ),
});

export const GET = authedHandler(async (auth, request) => {
  requireRole(auth, "viewer");
  const rows = await activeSuggestions();
  const parsed = suggestionsResponse.safeParse({ facts: rows });
  if (!parsed.success) {
    return problemResponse(500, "invalid_state", "A stored suggestion does not match the contract.");
  }
  return withCors(Response.json(parsed.data), request.headers.get("origin"));
});
