import { z } from "zod";
import { authedHandler } from "@/lib/auth";
import { requireRole, requireScope } from "@/lib/auth/guards";
import { preflight, withCors } from "@/lib/cors";
import { problemResponse } from "@/lib/problems";
import { ConflictError, createFocusBlocklistEntry } from "@/domains/focus/commands";
import { listFocusBlocklist } from "@/domains/focus/queries";

/*
 * GET /api/v1/focus/blocklist — the entries the browser extension enforces and
 * the setup screen curates. The array order IS the precedence: allow entries
 * come before block entries (a matching allow wins over any matching block),
 * each kind alphabetical by pattern, so the client walks front to back and
 * stops at the first hit.
 * POST /api/v1/focus/blocklist — add a pattern, defaulting to a block.
 *
 * Reads and writes are scoped differently on purpose. A machine key reads with
 * `focus:read` — the extension polls the list on session start. But no key can
 * ever carry a write scope: `focus:write` is deliberately absent from
 * API_KEY_SCOPES, so this route's writes resolve only for signed-in humans.
 * A machine key that could weaken the blocklist would let a blocked page
 * un-block itself through its own companion.
 *
 * CORS is scoped to the companion's origin; see src/lib/cors.ts.
 */

const blocklistRequest = z.object({
  pattern: z.string().trim().min(1).max(500),
  kind: z.enum(["block", "allow"]).optional(),
});

export const OPTIONS = async (request: Request) => preflight(request.headers.get("origin"));

export const GET = authedHandler(async (auth, request) => {
  requireRole(auth, "viewer");
  requireScope(auth, "focus:read");
  const entries = await listFocusBlocklist(auth);
  return withCors(Response.json({ entries }), request.headers.get("origin"));
});

export const POST = authedHandler(async (auth, request) => {
  requireRole(auth, "member");
  requireScope(auth, "focus:write");
  const origin = request.headers.get("origin");
  const parsed = blocklistRequest.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return withCors(
      problemResponse(422, "invalid_input", "Send a pattern (max 500 chars) and an optional kind: block or allow."),
      origin,
    );
  }

  try {
    const entry = await createFocusBlocklistEntry(auth, parsed.data);
    return withCors(Response.json({ entry }, { status: 201 }), origin);
  } catch (cause) {
    if (cause instanceof ConflictError) {
      // Additive member, the captures contract: the id of the entry that is
      // already there, so the setup screen can flip to editing it.
      const extra = cause.existingId ? { existingBlocklistId: cause.existingId } : undefined;
      return withCors(problemResponse(409, cause.code, cause.message, extra), origin);
    }
    throw cause;
  }
});
