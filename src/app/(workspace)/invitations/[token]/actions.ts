"use server";

import { revalidatePath, updateTag } from "next/cache";
import { acceptInvitation } from "@/domains/identity/invitations";
import { actionError } from "@/lib/action-error";
import { getAuthContext } from "@/lib/auth";
import { workspacesTag } from "@/lib/cache-tags";
import { sessionVerifiedEmail } from "./session-email";

// Same copy for every dead end - unknown, expired, revoked, expended, or a
// session that does not match the recipient - so the route never confirms
// which tokens exist (the domain's own probe-resistance rule).
const INVALID = "This invitation is not valid. Ask for a fresh link.";

// Acceptance has no role gate by design: the acceptor is not a member yet.
// Its authorization is the invitation's own email match, enforced by the
// domain; authorize() only resolves the session that match runs against.
async function authorize() {
  return getAuthContext();
}

/*
 * The accept half of spec D4. The domain stays the enforcement surface:
 * acceptInvitation re-checks the pending state, matches the verified email,
 * guards the reusage race, and records invitation.accepted. This action only
 * resolves the session, hands over the verified email, and refreshes the
 * Access console both members see afterwards.
 */
export async function acceptInvitationAction(
  token: string,
): Promise<{ ok: true; workspaceId: string; role: string; replayed: boolean } | { ok: false; error: string }> {
  let auth;
  try {
    auth = await authorize();
  } catch {
    return { ok: false, error: INVALID };
  }
  try {
    const verifiedEmail = await sessionVerifiedEmail(auth);
    const result = await acceptInvitation({ token: String(token || ""), userId: auth.userId, verifiedEmail });
    // The acceptor's switcher is cached per user; the new membership must be
    // on their next render, which is exactly when they navigate back to the app.
    updateTag(workspacesTag(auth.userId));
    revalidatePath("/settings/access");
    return { ok: true, workspaceId: result.workspaceId, role: result.role, replayed: result.replayed };
  } catch (error) {
    return { ok: false, error: actionError(error, INVALID) };
  }
}
