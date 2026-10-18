import { z } from "zod";
import { authedHandler } from "@/lib/auth";
import { requireRole } from "@/lib/auth/guards";
import { problemResponse } from "@/lib/problems";
import { DossierError, createDossier, listDossiers } from "@/domains/knowledge/dossiers";

/*
 * GET /api/v1/dossiers — the workspace's dossiers with document counts.
 * POST /api/v1/dossiers — a name plus document ids. Any id outside this
 * workspace fails the whole request with 422 and nothing is created.
 */
export const GET = authedHandler(async (auth) => Response.json({ dossiers: await listDossiers(auth) }));

const create = z.object({
  name: z.string().min(1).max(200),
  documentIds: z.array(z.string().uuid()).max(200).default([]),
});

export const POST = authedHandler(async (auth, request) => {
  requireRole(auth, "member");
  const parsed = create.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return problemResponse(422, "invalid_input", "Give a name and a list of document ids.");
  try {
    const dossier = await createDossier(auth, parsed.data);
    return Response.json({ dossier }, { status: 201 });
  } catch (cause) {
    if (cause instanceof DossierError) return problemResponse(422, cause.code, cause.message);
    throw cause;
  }
});
