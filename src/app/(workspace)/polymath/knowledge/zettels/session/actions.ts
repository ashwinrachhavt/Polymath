"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { getAuthContext } from "@/lib/auth";
import {
  commitDecomposition,
  decomposePaste,
  PASTE_TOO_LONG,
  type DecompositionAnalysis,
} from "@/domains/knowledge/decomposition";
import { DECOMPOSE_MAX_CHARS, SittingError } from "@/domains/knowledge/sittings";
import { requireRole } from "@/lib/auth/guards";
import {
  addCardToSitting,
  createSitting,
  getSitting,
} from "@/domains/knowledge/sittings";
import { commitNoteSnapshot, createNote, VersionConflictError } from "@/domains/knowledge/notes";
import { db } from "@/lib/db";
import { artifacts, artifactVersions } from "@/domains/knowledge/schema";
import { and, eq, isNull } from "drizzle-orm";

/*
 * Sitting server actions (plan §7): the shell talks to the server through
 * these; the creation stream itself lives on the §16.6 endpoint.
 */

/** New sitting (§14.1): create and land in the workspace with the cursor blinking. */
export async function createSittingAction(input: { topic?: string; sourceDocumentId?: string }) {
  const auth = await getAuthContext();
  requireRole(auth, "member");
  const sitting = await createSitting(auth, {
    topic: input.topic?.trim() || undefined,
    // §7: seeding from the inbox flow passes a document reference; there is
    // no separate seed action.
    sourceContext: input.sourceDocumentId ? `document:${input.sourceDocumentId}` : undefined,
  });
  redirect(`/polymath/knowledge/zettels/session/${sitting.id}`);
}

const SaveCard = z.object({
  sittingId: z.string().uuid(),
  artifactId: z.string().uuid().optional(),
  expectedVersion: z.number().int().positive().optional(),
  idempotencyKey: z.string().min(8).max(200),
  title: z.string().max(500),
  content: z.unknown(),
  plainText: z.string(),
});

/*
 * Save-first (§3): the pause saves the draft as an artifact version and only
 * then does the creation run start. Double-submit creates one artifact
 * (§11): the idempotency key rides createNote/commitNoteSnapshot's receipt.
 */
export type SaveCardResult =
  | { artifactId: string; versionNumber: number }
  | { error: "invalid_input" | "sitting_not_found" }
  /* §14.4 conflict: the server moved; the client compares, keeps, or takes. */
  | { error: "version_conflict"; server: { plainText: string; version: number; updatedAt: string } };

export async function saveSittingCardAction(raw: unknown): Promise<SaveCardResult> {
  const auth = await getAuthContext();
  requireRole(auth, "member");
  const input = SaveCard.safeParse(raw);
  if (!input.success) return { error: "invalid_input" };
  const sitting = await getSitting(auth, input.data.sittingId);
  if (!sitting) return { error: "sitting_not_found" };

  if (input.data.artifactId && input.data.expectedVersion) {
    try {
      const snapshot = await commitNoteSnapshot(auth, {
        idempotencyKey: input.data.idempotencyKey,
        artifactId: input.data.artifactId,
        expectedVersion: input.data.expectedVersion,
        content: input.data.content as never,
        plainText: input.data.plainText,
      });
      return { artifactId: input.data.artifactId, versionNumber: snapshot.versionNumber };
    } catch (cause) {
      if (!(cause instanceof VersionConflictError)) throw cause;
      const [server] = await db
        .select({ plainText: artifactVersions.plainText, version: artifacts.version, updatedAt: artifacts.updatedAt })
        .from(artifacts)
        .leftJoin(artifactVersions, eq(artifactVersions.id, artifacts.currentVersionId))
        .where(and(eq(artifacts.id, input.data.artifactId), eq(artifacts.workspaceId, auth.workspaceId), isNull(artifacts.archivedAt)))
        .limit(1);
      return {
        error: "version_conflict",
        server: {
          plainText: server?.plainText ?? "",
          version: server?.version ?? input.data.expectedVersion,
          updatedAt: (server?.updatedAt ?? new Date()).toISOString(),
        },
      };
    }
  }
  const created = await createNote(auth, {
    idempotencyKey: input.data.idempotencyKey,
    title: input.data.title.trim() || "Untitled",
    content: input.data.content as never,
    plainText: input.data.plainText,
    kind: "zettel",
  });
  await addCardToSitting(auth, { sittingId: sitting.id, artifactId: created.id, role: "created_here" });
  return { artifactId: created.id, versionNumber: 1 };
}

const AnalyzePaste = z.object({ text: z.string().min(1).max(DECOMPOSE_MAX_CHARS + 1) });
const CommitDecomposition = z.object({
  analysis: z.unknown(),
  decisions: z.array(
    z.discriminatedUnion("action", [
      z.object({ candidateId: z.string(), action: z.literal("skip") }),
      z.object({ candidateId: z.string(), action: z.literal("create") }),
      z.object({ candidateId: z.string(), action: z.literal("merge"), targetArtifactId: z.string().uuid() }),
      z.object({ candidateId: z.string(), action: z.literal("link"), targetArtifactId: z.string().uuid() }),
    ]),
  ),
  idempotencyKey: z.string().min(8).max(200),
});

/*
 * §14.6: a paste over DECOMPOSE_PASTE_CHARS offers extraction review. The
 * analysis itself writes nothing (§4: proposal-generating compiler); the
 * over-cap rejection is the exact §15.1 copy, never a silent truncation.
 */
export async function analyzePasteAction(raw: unknown): Promise<{ analysis: DecompositionAnalysis } | { error: string; message: string }> {
  const auth = await getAuthContext();
  requireRole(auth, "member");
  const input = AnalyzePaste.safeParse(raw);
  if (!input.success) return { error: "invalid_input", message: "Nothing to analyze." };
  if (input.data.text.length > DECOMPOSE_MAX_CHARS) return { error: "too_long", message: PASTE_TOO_LONG };
  try {
    return { analysis: await decomposePaste(auth, input.data.text) };
  } catch (cause) {
    if (cause instanceof SittingError) return { error: cause.code, message: cause.message };
    return { error: "decompose_failed", message: "Analysis failed - nothing was written. Retry when ready." };
  }
}

/** §14.6 commit: the reviewer's decisions, batch-idempotent on the dedupe keys. */
export async function commitDecompositionAction(raw: unknown): Promise<
  | { created: { candidateId: string; destination: "zettel" | "note" | "task"; id: string }[]; merged: { candidateId: string; targetId: string; versionNumber: number }[]; linked: { candidateId: string; id: string; targetId: string }[]; skipped: string[] }
  | { error: string; message: string }
> {
  const auth = await getAuthContext();
  requireRole(auth, "member");
  const input = CommitDecomposition.safeParse(raw);
  if (!input.success) return { error: "invalid_input", message: "The decisions could not be read." };
  try {
    return await commitDecomposition(auth, {
      analysis: input.data.analysis as DecompositionAnalysis,
      decisions: input.data.decisions,
      idempotencyKey: input.data.idempotencyKey,
    });
  } catch (cause) {
    if (cause instanceof SittingError) return { error: cause.code, message: cause.message };
    return { error: "commit_failed", message: "Commit failed partway-safe: accepted cards keep their idempotency keys, so retrying never duplicates." };
  }
}
