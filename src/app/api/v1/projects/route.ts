import { z } from "zod";
import { authedHandler } from "@/lib/auth";
import { requireRole } from "@/lib/auth/guards";
import { problemResponse } from "@/lib/problems";
import { ProjectError, createProject, listProjects } from "@/domains/knowledge/projects";

/*
 * GET /api/v1/projects - the workspace notebooks (Projects in the UI) with source counts.
 * POST /api/v1/projects — a name plus document ids. Any id outside this
 * workspace fails the whole request with 422 and nothing is created.
 */
export const GET = authedHandler(async (auth) => Response.json({ notebooks: await listProjects(auth) }));

const create = z.object({
  name: z.string().min(1).max(200),
  documentIds: z.array(z.string().uuid()).max(200).default([]),
});

export const POST = authedHandler(async (auth, request) => {
  requireRole(auth, "member");
  const parsed = create.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return problemResponse(422, "invalid_input", "Give the notebook a name.");
  try {
    const project = await createProject(auth, parsed.data);
    return Response.json({ project }, { status: 201 });
  } catch (cause) {
    if (cause instanceof ProjectError) return problemResponse(422, cause.code, cause.message);
    throw cause;
  }
});
