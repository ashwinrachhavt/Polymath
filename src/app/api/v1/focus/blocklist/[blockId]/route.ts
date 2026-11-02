import { z } from "zod";
import { authedHandler } from "@/lib/auth";
import { requireRole, requireScope } from "@/lib/auth/guards";
import { problemResponse } from "@/lib/problems";
import { ConflictError, archiveFocusBlocklistEntry, updateFocusBlocklistEntry } from "@/domains/focus/commands";

/*
 * PATCH /api/v1/focus/blocklist/:blockId — flip a pattern's verdict or rename it.
 * DELETE /api/v1/focus/blocklist/:blockId — archive the entry; the pattern's
 * key frees up for re-adding, and the row stays for the audit trail.
 *
 * Writes are same-origin only (the setup screen): no CORS here, matching the
 * captures subroutes. And like POST, the focus:write scope is one no machine
 * key can carry — curation is a signed-in member's act.
 */

const patchRequest = z
  .object({
    pattern: z.string().trim().min(1).max(500).optional(),
    kind: z.enum(["block", "allow"]).optional(),
  })
  .refine((value) => value.pattern !== undefined || value.kind !== undefined, {
    message: "Send a pattern, a kind, or both.",
  });

function isBlockId(id: string): boolean {
  return /^[0-9a-f-]{36}$/i.test(id);
}

export const PATCH = authedHandler(async (auth, request, ctx: { params: Promise<{ blockId: string }> }) => {
  requireRole(auth, "member");
  requireScope(auth, "focus:write");
  const { blockId } = await ctx.params;
  if (!isBlockId(blockId)) return problemResponse(404, "not_found", "No such blocklist entry in this workspace.");

  const parsed = patchRequest.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return problemResponse(422, "invalid_input", "Send a pattern, a kind, or both.");
  }

  try {
    const entry = await updateFocusBlocklistEntry(auth, blockId, parsed.data);
    if (!entry) return problemResponse(404, "not_found", "No such blocklist entry in this workspace.");
    return Response.json({ entry });
  } catch (cause) {
    if (cause instanceof ConflictError) {
      return problemResponse(409, cause.code, cause.message);
    }
    throw cause;
  }
});

export const DELETE = authedHandler(async (auth, _request, ctx: { params: Promise<{ blockId: string }> }) => {
  requireRole(auth, "member");
  requireScope(auth, "focus:write");
  const { blockId } = await ctx.params;
  if (!isBlockId(blockId)) return problemResponse(404, "not_found", "No such blocklist entry in this workspace.");

  const entry = await archiveFocusBlocklistEntry(auth, blockId);
  if (!entry) return problemResponse(404, "not_found", "No such blocklist entry in this workspace.");
  return Response.json({ entry });
});
