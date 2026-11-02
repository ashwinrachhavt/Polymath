import { authedHandler } from "@/lib/auth";
import { requireScope } from "@/lib/auth/guards";
import { getLiveFocusDock } from "@/domains/focus/queries";

/*
 * GET /api/v1/focus/live - the workspace's live focus session (running or
 * paused), named for the app shell's dock, or null. Read-only and scoped to
 * the signed-in workspace; the dock re-reads it on navigation and when the tab
 * regains focus, so a session started or ended elsewhere shows within a click.
 * Machine keys read it under the focus:read scope, like the blocklist they
 * poll; humans pass the scope check by role alone.
 */
export const GET = authedHandler(async (auth) => {
  requireScope(auth, "focus:read");
  const session = await getLiveFocusDock(auth);
  return Response.json({ session }, { headers: { "Cache-Control": "no-store" } });
});
