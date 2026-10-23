/*
 * One problem+json shape across the API (RFC 9457). Codes are added, never
 * repurposed: a client switching on `code` must not change meaning when a new
 * failure is introduced somewhere else.
 */
export function problemResponse(status: number, code: string, title: string, extra?: Record<string, unknown>): Response {
  return Response.json(
    // The first four members are the pinned contract; `extra` is additive
    // only (e.g. existingCaptureId on a duplicate), never a reshape.
    { type: `https://axiom.dev/problems/${code}`, code, title, status, ...extra },
    { status, headers: { "content-type": "application/problem+json" } },
  );
}
