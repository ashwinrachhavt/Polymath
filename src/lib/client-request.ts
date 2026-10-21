/*
 * One client-safe request path for the browser islands that call /api/v1.
 * Every caller had its own try/fetch/json().catch() block; they drifted on
 * what a network failure vs a 401 vs a 500 says to the person. This maps each
 * failure class to a message that names the recovery, and never surfaces a
 * raw payload.
 */

export type RequestFailureKind =
  | "unauthenticated"
  | "forbidden"
  | "not_found"
  | "conflict"
  | "validation"
  | "rate_limited"
  | "server"
  | "network"
  | "timeout"
  | "aborted"
  | "malformed";

export type RequestFailure = {
  /** Coarse class, chosen for the copy the person should see. */
  kind: RequestFailureKind;
  title: string;
  /** Stable machine code from a problem+json body, when the server sent one. */
  code?: string;
};

const STATUS_KIND: Record<number, RequestFailureKind> = {
  401: "unauthenticated",
  403: "forbidden",
  404: "not_found",
  409: "conflict",
  422: "validation",
  429: "rate_limited",
};

const KIND_COPY: Record<RequestFailureKind, string> = {
  unauthenticated: "Your session has expired. Sign in again, then retry.",
  forbidden: "Your role does not allow this action.",
  not_found: "That record no longer exists. Refresh to see the current list.",
  conflict: "Someone else changed this first. Refresh and reapply your change.",
  validation: "The request was not valid. Check the fields and try again.",
  rate_limited: "Too many requests. Wait a moment and try again.",
  server: "The server could not complete this. Try again; if it keeps failing, wait and retry later.",
  network: "The request did not reach the server. Check your connection, then retry; if a change was being submitted, check the record before sending it again.",
  timeout: "The server did not answer in time. Retry; if the change was a submission, check the record before sending it again.",
  aborted: "The request was cancelled. If a change was being submitted, check the record before sending it again.",
  malformed: "The server answered, but the response could not be read. Retry; if it keeps happening, reload the page.",
};

function copyFor(kind: RequestFailureKind, title: string | null): string {
  return title ?? KIND_COPY[kind];
}

function isAbortError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { name?: unknown }).name === "AbortError"
  );
}

/*
 * AbortSignal.timeout() rejects fetch with a TimeoutError, which is neither a
 * cancellation (nobody aborted it) nor a broken connection (the request may
 * well have reached the server and be running). Reporting it as `network`
 * told the person to check a connection that was fine.
 */
function isTimeoutError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { name?: unknown }).name === "TimeoutError"
  );
}

/*
 * Read the body once, as text, so an empty body is distinguishable from a
 * malformed one. The parsed value is untrusted; callers narrow it.
 *
 * A signal can also fire after the headers arrive, while the body is still
 * draining; that rejects text() with an AbortError. It is a cancellation, not
 * an unreadable response, and must not be reported as `malformed`.
 */
type BodyRead =
  | { status: "ok"; value: unknown }
  | { status: "malformed" }
  | { status: "aborted" };

async function readBody(response: Response): Promise<BodyRead> {
  let text: string;
  try {
    text = await response.text();
  } catch (error) {
    return { status: isAbortError(error) ? "aborted" : "malformed" };
  }
  if (text.trim() === "") return { status: "malformed" };
  try {
    return { status: "ok", value: JSON.parse(text) as unknown };
  } catch {
    return { status: "malformed" };
  }
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
  } catch (error) {
    // A caller's AbortSignal firing rejects fetch with an AbortError. That is
    // a cancellation, not a broken connection; telling the person their
    // network failed would be a lie about something they did themselves.
    if (isAbortError(error)) {
      return { ok: false, failure: { kind: "aborted", title: KIND_COPY.aborted } };
    }
    if (isTimeoutError(error)) {
      return { ok: false, failure: { kind: "timeout", title: KIND_COPY.timeout } };
    }
    return { ok: false, failure: { kind: "network", title: KIND_COPY.network } };
  }
  if (response.ok) {
    const body = await readBody(response);
    if (body.status === "aborted") {
      return { ok: false, failure: { kind: "aborted", title: KIND_COPY.aborted } };
    }
    // Every caller expects a JSON object of its declared type. An empty or
    // unparseable success body (a proxy page, a 204 from an endpoint that
    // should have returned a record) is not `server`: the server answered,
    // the response could not be read.
    if (body.status === "malformed" || body.value === null) {
      return { ok: false, failure: { kind: "malformed", title: KIND_COPY.malformed } };
    }
    return { ok: true, data: body.value as T };
  }
  const body = await readBody(response);
  if (body.status === "aborted") {
    return { ok: false, failure: { kind: "aborted", title: KIND_COPY.aborted } };
  }
  const problem =
    body.status === "ok" && typeof body.value === "object" && body.value !== null
      ? (body.value as { title?: unknown; code?: unknown })
      : null;
  const kind = STATUS_KIND[response.status] ?? "server";
  const title =
    typeof problem?.title === "string" && problem.title.trim() !== "" ? problem.title : null;
  const code =
    typeof problem?.code === "string" && problem.code.trim() !== ""
      ? problem.code
      : undefined;
  const failure: RequestFailure = { kind, title: copyFor(kind, title) };
  if (code !== undefined) failure.code = code;
  return { ok: false, failure };
}
