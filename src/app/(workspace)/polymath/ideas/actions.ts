"use server";

import { and, eq, isNull } from "drizzle-orm";
import { refresh } from "next/cache";
import { z } from "zod";
import { artifactVersions, artifacts, TIDY_RESOLUTIONS } from "@/domains/knowledge/schema";
import { commitNoteSnapshot, createNote, VersionConflictError } from "@/domains/knowledge/notes";
import {
  dismissFinding,
  resolveDisagreement,
  runTidyPass,
  TidyFindingNotFoundError,
  TidyTransitionError,
} from "@/domains/knowledge/tidy";
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
        .where(
          and(
            eq(artifacts.id, input.data.artifactId),
            eq(artifacts.workspaceId, auth.workspaceId),
            isNull(artifacts.archivedAt),
          ),
        )
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

/*
 * Tidy decisions. The domain owns the rules (tidy.ts); these parse, authorize
 * and refresh. A finding already decided elsewhere reads as settled, and the
 * refreshed page shows what is still open.
 */

export type TidyDecisionResult = { ok: true } | { ok: false; error: string };

const ResolveDisagreement = z.object({
  findingId: z.string().uuid(),
  outcome: z.enum(TIDY_RESOLUTIONS),
  note: z.string().max(500).optional(),
});
const DismissFinding = z.object({ findingId: z.string().uuid() });

async function decideTidy(run: () => Promise<void>): Promise<TidyDecisionResult> {
  try {
    await run();
  } catch (cause) {
    if (cause instanceof TidyFindingNotFoundError || cause instanceof TidyTransitionError) {
      refresh();
      return { ok: false, error: "This was already settled or no longer exists." };
    }
    throw cause;
  }
  refresh();
  return { ok: true };
}

export async function resolveDisagreementAction(raw: unknown): Promise<TidyDecisionResult> {
  const auth = await getAuthContext();
  requireRole(auth, "member");
  const input = ResolveDisagreement.safeParse(raw);
  if (!input.success) return { ok: false, error: "That decision could not be read." };
  return decideTidy(() => resolveDisagreement(auth, input.data));
}

export async function dismissFindingAction(raw: unknown): Promise<TidyDecisionResult> {
  const auth = await getAuthContext();
  requireRole(auth, "member");
  const input = DismissFinding.safeParse(raw);
  if (!input.success) return { ok: false, error: "That decision could not be read." };
  return decideTidy(() => dismissFinding(auth, input.data));
}

/** One bounded pass now, for a person who does not want to wait for tomorrow's. */
export async function runTidyNowAction(): Promise<{ message: string }> {
  const auth = await getAuthContext();
  requireRole(auth, "member");
  const summary = await runTidyPass(auth);
  refresh();
  const review = summary.pairReview;
  const found = summary.opened + (review.status === "skipped" ? 0 : review.disagreements + review.duplicates);
  const parts = [found === 0 ? "Nothing new found." : `Found ${found} new ${found === 1 ? "thing" : "things"} to look at.`];
  // "Nothing new" must never read as "no disagreements" when ideas were not compared.
  if (review.status === "skipped") {
    parts.push("Ideas were not compared with each other, because no model is set up. Only sources and loose ends were checked.");
  } else if (review.status === "stopped" && review.stoppedBy === "comparison_failed") {
    parts.push("Comparing ideas failed partway, so some were not checked. Try again later.");
  } else if (review.status === "stopped") {
    parts.push("Some ideas are left for the next run.");
  }
  return { message: parts.join(" ") };
}
