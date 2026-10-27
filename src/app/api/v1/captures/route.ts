import { z } from "zod";
import { authedHandler } from "@/lib/auth";
import { requireRole, requireScope } from "@/lib/auth/guards";
import { preflight, withCors } from "@/lib/cors";
import { problemResponse } from "@/lib/problems";
import { ConflictError, createCapture } from "@/domains/capture/commands";
import { listCaptures } from "@/domains/capture/queries";

/*
 * GET /api/v1/captures — the inbox queue (unprocessed by default).
 * POST /api/v1/captures — text, a selection, or a page grab into the inbox.
 *
 * The companion states the arrival mode. A page grab carries the flattened page
 * text and is a page capture; a selection is one reading of that address; a
 * bare address is a url-reference that dedupes on (workspace, source, url) and
 * answers 409 rather than making a second row. Omitting mode infers it from
 * what arrived, so an older companion build keeps working.
 * CORS is scoped to the companion's origin; see src/lib/cors.ts.
 */

const captureRequest = z
  .object({
    text: z.string().max(200_000).optional(),
    url: z.string().url().max(2_000).optional(),
    title: z.string().max(500).optional(),
    mode: z.enum(["authored", "selection", "page", "url-reference"]).optional(),
  })
  .refine((value) => Boolean(value.text?.trim() || value.url), {
    message: "Send text, a url, or both.",
  });

const filterSchema = z.enum(["unprocessed", "parked", "converted", "discarded", "all"]);

export const OPTIONS = async (request: Request) => preflight(request.headers.get("origin"));

export const GET = authedHandler(async (auth, request) => {
  requireRole(auth, "viewer");
  requireScope(auth, "captures:read");
  const parsed = filterSchema.safeParse(new URL(request.url).searchParams.get("filter") ?? "unprocessed");
  if (!parsed.success) {
    return withCors(
      problemResponse(422, "invalid_input", "filter must be unprocessed, converted, discarded, or all."),
      request.headers.get("origin"),
    );
  }
  const rows = await listCaptures(auth, parsed.data);
  return withCors(Response.json({ captures: rows }), request.headers.get("origin"));
});

export const POST = authedHandler(async (auth, request) => {
  requireRole(auth, "member");
  requireScope(auth, "captures:write");
  const origin = request.headers.get("origin");
  const parsed = captureRequest.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return withCors(problemResponse(422, "invalid_input", "Send text, a url, or both (max 200k chars)."), origin);
  }

  const { text, url, title, mode } = parsed.data;
  // A page grab arrives as { url, text }; a bare URL or a plain note is text-only.
  const body = text?.trim() || url || "";
  // An address that arrived with no text of its own is the address itself, not
  // a page grab whose body happens to be the address. Everything else is left
  // for the server to infer from what arrived.
  const arrival = mode ?? (text?.trim() ? undefined : url ? "url-reference" : undefined);
  const idempotencyKey = request.headers.get("idempotency-key") ?? undefined;
  if (idempotencyKey !== undefined && !z.string().uuid().safeParse(idempotencyKey).success) {
    return withCors(problemResponse(400, "invalid_request", "Idempotency-Key must be a UUID."), origin);
  }

  try {
    const capture = await createCapture(auth, {
      text: body,
      url: url ?? undefined,
      title,
      mode: arrival,
      source: "companion",
      idempotencyKey,
    });
    return withCors(Response.json({ capture }, { status: 201 }), origin);
  } catch (cause) {
    if (cause instanceof ConflictError) {
      // Companion contract: type/code/title/status stay byte-exact; the id of
      // the capture that is already there is an additive member.
      const extra = cause.existingId ? { existingCaptureId: cause.existingId } : undefined;
      return withCors(problemResponse(409, cause.code, cause.message, extra), origin);
    }
    throw cause;
  }
});
