"use server";

import { z } from "zod";
import { recordReadingEvent, ReadingDocumentMissingError } from "@/domains/knowledge/reading";
import { restoreDocumentVersion, VersionRestoreError } from "@/domains/knowledge/versions";
import { getAuthContext, type AuthContext } from "@/lib/auth";
import { requireRole } from "@/lib/auth/guards";

/*
 * The reader's one mutation. Any workspace member (viewer included) records
 * their own reading; the state row is per (document, user), so one member's
 * history never touches another's. The client_event_id is the idempotency
 * key: a retried beacon folds once.
 */

const inputSchema = z.object({
  documentId: z.string().uuid(),
  visitId: z.string().uuid(),
  kind: z.enum(["opened", "progress", "closed"]),
  progress: z.number().min(0).max(1).nullish(),
  page: z.number().int().positive().nullish(),
  activeSeconds: z.number().int().min(0).max(4 * 60 * 60).nullish(),
  clientEventId: z.string().uuid().optional(),
});

async function authorize(): Promise<AuthContext> {
  const auth = await getAuthContext();
  requireRole(auth, "viewer");
  return auth;
}

export async function recordReadingEventAction(raw: z.infer<typeof inputSchema>) {
  const auth = await authorize();
  const input = inputSchema.parse(raw);
  try {
    const result = await recordReadingEvent(auth, input);
    return { ok: true as const, replayed: result.replayed };
  } catch (cause) {
    if (cause instanceof ReadingDocumentMissingError) {
      return { ok: false as const, error: "That document is no longer available." };
    }
    throw cause;
  }
}

/*
 * Restore an earlier version. Editors decide what the document reads as; the
 * version list itself is append-only, so a restore is a pointer move plus an
 * audit row, never a delete or rewrite.
 */

const restoreSchema = z.object({
  documentId: z.string().uuid(),
  extractionId: z.string().uuid(),
  expectedVersion: z.number().int().min(0),
});

export async function restoreDocumentVersionAction(raw: z.infer<typeof restoreSchema>) {
  const auth = await authorize();
  requireRole(auth, "member");
  const input = restoreSchema.parse(raw);
  try {
    const result = await restoreDocumentVersion(auth, input);
    return { ok: true as const, restored: result.restored };
  } catch (cause) {
    if (cause instanceof VersionRestoreError) {
      if (cause.code === "not_found") return { ok: false as const, error: "That version is not available." };
      if (cause.code === "not_succeeded") return { ok: false as const, error: "Only a successfully read version can be restored." };
      if (cause.code === "stale_write") return { ok: false as const, error: "That document changed. Reload to see the current state." };
    }
    throw cause;
  }
}
