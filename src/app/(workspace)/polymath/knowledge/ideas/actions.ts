"use server";

import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { artifactVersions, artifacts } from "@/domains/knowledge/schema";
import { commitNoteSnapshot, createNote, VersionConflictError } from "@/domains/knowledge/notes";
import { db } from "@/lib/db";
import { getAuthContext } from "@/lib/auth";
import { requireRole } from "@/lib/auth/guards";

/*
 * §14.11: the "New idea" direct flow saves as an authored artifact version
 * through the same machinery a sitting's Keep uses (receipt-keyed create,
 * version-claimed snapshot), minus the sitting. Same contract as
 * saveSittingCardAction so the two flows can never drift apart on conflict
 * semantics.
 */

const SaveIdea = z.object({
  idempotencyKey: z.string().min(1),
  artifactId: z.string().optional(),
  expectedVersion: z.number().int().optional(),
  title: z.string().max(200),
  content: z.unknown(),
  plainText: z.string(),
});

export type SaveIdeaResult =
  | { artifactId: string; versionNumber: number }
  | { error: "invalid_input" | "version_conflict"; server?: { plainText: string; version: number; updatedAt: string } };

export async function saveIdeaAction(raw: unknown): Promise<SaveIdeaResult> {
  const auth = await getAuthContext();
  requireRole(auth, "member");
  const input = SaveIdea.safeParse(raw);
  if (!input.success) return { error: "invalid_input" };

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
  return { artifactId: created.id, versionNumber: 1 };
}
