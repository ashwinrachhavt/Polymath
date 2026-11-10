"use server";

import { z } from "zod";
import { recordDocumentOpen } from "@/domains/knowledge/document-opens";
import { getAuthContext } from "@/lib/auth";
import { requireRole } from "@/lib/auth/guards";

/*
 * Records that the caller opened a document in the Vault. Any workspace
 * member, viewer included, records their own opens; the domain scopes the
 * write to the caller's workspace and user.
 */
export async function recordDocumentOpenAction(raw: unknown): Promise<{ ok: boolean }> {
  const auth = await getAuthContext();
  requireRole(auth, "viewer");
  const documentId = z.string().uuid().parse(raw);
  return { ok: await recordDocumentOpen(auth, documentId) };
}
