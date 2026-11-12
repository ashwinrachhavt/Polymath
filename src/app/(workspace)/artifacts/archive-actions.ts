"use server";

import { refresh } from "next/cache";
import { z } from "zod";
import { ArtifactArchiveError, archiveArtifact, restoreArtifact } from "@/domains/knowledge/artifact-archive";
import type { AuthContext } from "@/domains/identity/resolve";
import { getAuthContext } from "@/lib/auth";
import { requireRole } from "@/lib/auth/guards";

/*
 * Delete and Undo for ideas and generated artifacts (one table, one pair of
 * actions; the Ideas and Artifacts surfaces both call these). Expected
 * failures come back as a result, not a throw: production hides a thrown
 * server-action message, and the delete toast needs the words.
 */

type ArchiveResult = { ok: true } | { ok: false; error: string };

const input = z.object({ artifactId: z.string().uuid() });

async function run(auth: AuthContext, raw: unknown, write: typeof archiveArtifact): Promise<ArchiveResult> {
  const parsed = input.safeParse(raw);
  if (!parsed.success) return { ok: false, error: "That item is not available." };
  try {
    await write(auth, parsed.data);
  } catch (error) {
    if (error instanceof ArtifactArchiveError) return { ok: false, error: error.message };
    throw error;
  }
  refresh();
  return { ok: true };
}

export async function archiveArtifactAction(raw: { artifactId: string }): Promise<ArchiveResult> {
  const auth = await getAuthContext();
  requireRole(auth, "member");
  return run(auth, raw, archiveArtifact);
}

export async function restoreArtifactAction(raw: { artifactId: string }): Promise<ArchiveResult> {
  const auth = await getAuthContext();
  requireRole(auth, "member");
  return run(auth, raw, restoreArtifact);
}
