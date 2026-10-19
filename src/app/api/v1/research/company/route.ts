import { z } from "zod";
import { authedHandler } from "@/lib/auth";
import { requireRole } from "@/lib/auth/guards";
import { problemResponse } from "@/lib/problems";
import { CompanyResearchError, runCompanyResearch } from "@/domains/knowledge/company-research";

/*
 * POST /api/v1/research/company — run an evidence-grounded company research
 * pass (ASH-114). The engine owns the contract (dossier-only never searches,
 * as-of cutoff, citation-checked sections); this handler authenticates,
 * parses, and passes the Idempotency-Key through so a retry replays the first
 * pass instead of buying a second one.
 */

const body = z.object({
  companyName: z.string().trim().min(1).max(300),
  question: z.string().trim().max(1000).optional(),
  audience: z.string().trim().max(300).optional(),
  depth: z.enum(["quick", "standard", "deep"]).default("standard"),
  asOfDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  mode: z.enum(["public", "private", "dossier-only"]).default("public"),
  dossierId: z.string().uuid().optional(),
  peers: z.array(z.string().trim().min(1).max(200)).max(5).optional(),
});

export const POST = authedHandler(async (auth, request) => {
  requireRole(auth, "member");
  const parsed = body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return problemResponse(422, "invalid_input", "Give a companyName; depth, mode, and dates have fixed shapes.");
  }
  const key = request.headers.get("idempotency-key");
  if (key !== null && !z.string().uuid().safeParse(key).success) {
    return problemResponse(400, "invalid_request", "Idempotency-Key must be a UUID.");
  }
  try {
    const result = await runCompanyResearch(auth, { ...parsed.data, idempotencyKey: key ?? undefined });
    return Response.json(result, { status: result.replayed ? 200 : 201 });
  } catch (error) {
    if (error instanceof CompanyResearchError) {
      return problemResponse(422, "invalid_input", error.message);
    }
    throw error;
  }
});
