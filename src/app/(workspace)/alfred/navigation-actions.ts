"use server";

import type { NavigationReply } from "@/domains/supervisor/respond";
import { respondToNavigation } from "@/domains/supervisor/respond";
import { getAuthContext } from "@/lib/auth";
import { requireRole } from "@/lib/auth/guards";

/*
 * ASH-306: the composer's deterministic fork. A message that asks for a
 * surface is answered from canonical rows in the persistent Supervisor thread;
 * anything else returns null and the caller starts a model run as before.
 * Returning null (not throwing) keeps ordinary conversation off this path's
 * failure modes entirely.
 */
export async function navigateInConversation(input: { message: string }): Promise<NavigationReply | null> {
  const message = input.message?.trim();
  if (!message) return null;
  const auth = await getAuthContext();
  requireRole(auth, "member");
  return respondToNavigation(auth, message);
}
