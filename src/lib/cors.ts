/*
 * CORS for the browser companion only. Its content-script fetches are subject
 * to page CORS, unlike a service worker's; every other /api/v1 caller is
 * same-origin or a server, so this stays a fixed allowlist rather than a
 * wildcard. Add an origin here when a packed extension gets a stable ID.
 */

const ALLOWED_ORIGINS = [process.env.NEXT_PUBLIC_APP_URL, "http://localhost:3000"].filter(
  (origin): origin is string => Boolean(origin),
);

export function corsHeaders(origin: string | null): Record<string, string> {
  if (!origin || !ALLOWED_ORIGINS.includes(origin)) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, Idempotency-Key",
    "Access-Control-Max-Age": "600",
    Vary: "Origin",
  };
}

export function withCors(response: Response, origin: string | null): Response {
  const headers = corsHeaders(origin);
  if (Object.keys(headers).length === 0) return response;
  const merged = new Headers(response.headers);
  for (const [key, value] of Object.entries(headers)) merged.set(key, value);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers: merged });
}

/** The preflight the companion's OPTIONS request needs; empty response otherwise. */
export function preflight(origin: string | null): Response {
  return new Response(null, { status: 204, headers: corsHeaders(origin) });
}
