"use server";

import { z } from "zod";
import { recordReadingEvent, ReadingDocumentMissingError } from "@/domains/knowledge/reading";
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
