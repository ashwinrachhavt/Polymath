import { authedHandler } from "@/lib/auth";
import { requireRole, requireScope } from "@/lib/auth/guards";
import { preflight, withCors } from "@/lib/cors";

export const OPTIONS = async (request: Request) => preflight(request.headers.get("origin"));

/** Verify capture delivery authority without creating a capture or requiring read scope. */
export const GET = authedHandler(async (auth, request) => {
  requireRole(auth, "member");
  requireScope(auth, "captures:write");
  return withCors(Response.json({ ok: true, workspaceId: auth.workspaceId }), request.headers.get("origin"));
});
