/*
 * One client-safe request path for the browser islands that call /api/v1.
 * Every caller had its own try/fetch/json().catch() block; they drifted on
 * what a network failure vs a 401 vs a 500 says to the person. This maps each
 * failure class to a message that names the recovery, and never surfaces a
 * raw payload.
 */

export type RequestFailure =
  | { kind: "unauthenticated"; title: string }
  | { kind: "forbidden"; title: string }
  | { kind: "not_found"; title: string }
  | { kind: "conflict"; title: string }
  | { kind: "validation"; title: string }
  | { kind: "rate_limited"; title: string }
  | { kind: "server"; title: string }
  | { kind: "network"; title: string };

const STATUS_KIND: Record<number, RequestFailure["kind"]> = {
  401: "unauthenticated",
  403: "forbidden",
  404: "not_found",
  409: "conflict",
  422: "validation",
  429: "rate_limited",
};

const KIND_COPY: Record<RequestFailure["kind"], string> = {
  unauthenticated: "Your session has expired. Sign in again, then retry.",
  forbidden: "Your role does not allow this action.",
  not_found: "That record no longer exists. Refresh to see the current list.",
  conflict: "Someone else changed this first. Refresh and reapply your change.",
  validation: "The request was not valid. Check the fields and try again.",
  rate_limited: "Too many requests. Wait a moment and try again.",
  server: "The server could not complete this. Try again; if it keeps failing, wait and retry later.",
  network: "The request did not reach the server. Check your connection, then retry — nothing was submitted yet.",
};

function copyFor(kind: RequestFailure["kind"], title: string | null): string {
  return title ?? KIND_COPY[kind];
}

export async function requestJson<T>(
  input: string,
  init: { method?: string; body?: unknown; signal?: AbortSignal; idempotencyKey?: string } = {},
): Promise<{ ok: true; data: T } | { ok: false; failure: RequestFailure }> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  // Writes carry a fresh UUID per user intent; the server dedupes on replay,
  // so a browser retry or double-submit cannot apply the change twice.
  if (init.idempotencyKey) headers["idempotency-key"] = init.idempotencyKey;
  let response: Response;
  try {
    response = await fetch(input, {
      method: init.method ?? "GET",
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: init.signal,
    });
  } catch {
    return { ok: false, failure: { kind: "network", title: KIND_COPY.network } };
  }
  if (response.ok) {
    const data = (await response.json().catch(() => null)) as T | null;
    return data === null
      ? { ok: false, failure: { kind: "server", title: KIND_COPY.server } }
      : { ok: true, data };
  }
  const problem = (await response.json().catch(() => null)) as { title?: string } | null;
  const kind = STATUS_KIND[response.status] ?? "server";
  return { ok: false, failure: { kind, title: copyFor(kind, problem?.title ?? null) } };
}
