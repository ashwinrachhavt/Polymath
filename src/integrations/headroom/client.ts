/*
 * Headroom compression at the fetch seam (spec PR-3, "scope B: product
 * runtime"). The Headroom proxy compresses OpenAI-shaped chat payloads —
 * fresh tool output and new turns, never conversation history — before they
 * reach the provider. This module is the only product-runtime piece: a fetch
 * wrapper wired at exactly two seams (the `fetchImpl` handed to
 * `generationProvider`, and the eve `createOpenAI` fetch), and inert unless
 * HEADROOM_BASE_URL is set.
 *
 * Fail-open contract: compression is an optimization, never a dependency.
 * Proxy down, non-2xx, malformed response, or timeout (HEADROOM_TIMEOUT_MS,
 * default 1500ms) logs and passes the ORIGINAL request through — the model
 * call proceeds uncompressed. With the env unset the wrapper returns the
 * caller's fetch itself, so unset env is byte-identical behavior by
 * construction, and a caller-supplied test double is handed back untouched.
 *
 * Why not the `headroom-ai` npm SDK: it is a thin HTTP client for the same
 * proxy (its docs: "The TypeScript SDK sends messages to the Headroom proxy
 * over HTTP for compression"), and its defaults (30s timeout, one retry,
 * fallback flag) would fight the fail-fast contract here. The wire is two
 * fields against a pinned endpoint, so owning the call keeps the semantics
 * — no retries, no throw, one timeout — in one auditable place.
 *
 * Never log payloads: message content is user data and can carry secrets.
 */

/** One model call's chat payload, in the OpenAI wire shape both seams speak. */
interface ChatPayload {
  messages: unknown[];
  model?: unknown;
}

export const HEADROOM_TIMEOUT_MS_DEFAULT = 1500;

/**
 * The proxy base URL from the env, or null when the gate is off. Shared by
 * the gate check and the wrapper so they can never disagree.
 */
function baseUrlFrom(env: Record<string, string | undefined>): string | null {
  const raw = env.HEADROOM_BASE_URL?.trim();
  if (!raw) return null;
  // The SDK strips trailing slashes for the same reason: path joins below.
  return raw.replace(/\/+$/, "");
}

/** Whether product-runtime compression is on for this env. */
export function headroomEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return baseUrlFrom(env) !== null;
}

function timeoutMsFrom(env: Record<string, string | undefined>): number {
  const parsed = Number(env.HEADROOM_TIMEOUT_MS);
  // Unset, empty, or nonsense all take the default; so does a value that
  // would mean "no timeout" (0 or negative) — fail-open needs an upper bound.
  if (!Number.isFinite(parsed) || parsed <= 0) return HEADROOM_TIMEOUT_MS_DEFAULT;
  return parsed;
}

/**
 * The fetch wrapper. `headroomFetch(env, fetchImpl)` returns `fetchImpl`
 * itself while HEADROOM_BASE_URL is unset (identity, not a new closure, so
 * no code path can observe a difference), and a compressing wrapper when it
 * is set.
 */
export function headroomFetch(
  env: Record<string, string | undefined> = process.env,
  fetchImpl: typeof fetch = fetch,
): typeof fetch {
  const baseUrl = baseUrlFrom(env);
  if (!baseUrl) return fetchImpl;
  const timeoutMs = timeoutMsFrom(env);
  return async (input, init) => {
    const compressed = await compressedInit(baseUrl, timeoutMs, env, fetchImpl, init);
    return fetchImpl(input, compressed ?? init);
  };
}

/**
 * The request to hand the provider: the original unless compression changed
 * the body. Any failure inside here — including this function's own throws
 * from the proxy exchange — degrades to the original init.
 */
async function compressedInit(
  baseUrl: string,
  timeoutMs: number,
  env: Record<string, string | undefined>,
  fetchImpl: typeof fetch,
  init: RequestInit | undefined,
): Promise<RequestInit | undefined> {
  try {
    const payload = parseChatPayload(init);
    if (!payload) return init;
    const messages = await compressViaProxy(baseUrl, timeoutMs, env, fetchImpl, payload);
    if (!messages) return init;
    return {
      ...init,
      headers: withoutContentLength(init?.headers),
      body: JSON.stringify({ ...payload, messages }),
    };
  } catch (cause) {
    console.error("[headroom] compress failed, failing open", cause);
    return init;
  }
}

/**
 * The chat payload to compress, or null when the request is not one: only
 * JSON bodies carrying a `messages` array qualify. GETs, multipart uploads,
 * and embeddings' `input`-shaped bodies pass straight through, and so do
 * bodies that are not JSON at all (the same stance as the geminiFetch shim).
 */
function parseChatPayload(init: RequestInit | undefined): ChatPayload | null {
  if (typeof init?.body !== "string") return null;
  try {
    const parsed: unknown = JSON.parse(init.body);
    if (typeof parsed !== "object" || parsed === null) return null;
    const candidate = parsed as { messages?: unknown };
    if (!Array.isArray(candidate.messages)) return null;
    return candidate as ChatPayload;
  } catch {
    return null;
  }
}

/**
 * POST {baseUrl}/v1/compress — the proxy's compression-only endpoint (no
 * provider keys, no completion; the model name selects the tokenizer and
 * context limit). Returns the compressed messages, or null when the proxy
 * says it skipped compression (it fails open on its own internal timeouts:
 * 200 with the original messages and compression_skipped). Throws on
 * anything else, so the caller's fail-open catch decides.
 */
async function compressViaProxy(
  baseUrl: string,
  timeoutMs: number,
  env: Record<string, string | undefined>,
  fetchImpl: typeof fetch,
  payload: ChatPayload,
): Promise<unknown[] | null> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    // Integration slug for the proxy's own stats, matching the SDK's header.
    "X-Headroom-Stack": "polymath_runtime",
  };
  // Mirrors the official SDK's rawFetch auth on this endpoint: the proxy
  // token, plus the bearer form it also accepts.
  const apiKey = env.HEADROOM_API_KEY;
  if (apiKey) {
    headers["X-Headroom-Proxy-Token"] = apiKey;
    headers["Authorization"] = `Bearer ${apiKey}`;
  }
  const body: Record<string, unknown> = { messages: payload.messages };
  if (typeof payload.model === "string" && payload.model.length > 0) body.model = payload.model;

  const response = await withTimeout(timeoutMs, (signal) =>
    fetchImpl(`${baseUrl}/v1/compress`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal,
    }),
  );
  if (!response.ok) throw new Error(`headroom proxy responded ${response.status}`);
  // A non-JSON 200 throws here and lands in the caller's fail-open catch —
  // a protocol violation is a proxy failure and gets logged, not swallowed.
  const result = (await response.json()) as { messages?: unknown; compression_skipped?: boolean } | null;
  if (!result || result.compression_skipped === true) return null;
  if (!Array.isArray(result.messages)) throw new Error("headroom proxy returned no messages array");
  return result.messages;
}

/**
 * Run `start` under a hard timeout: rejects after `timeoutMs` even when the
 * response never arrives, aborting the in-flight request. A hand-rolled
 * race rather than AbortSignal.timeout so the rejection happens even when
 * the transport ignores the abort signal.
 */
function withTimeout<T>(timeoutMs: number, start: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`headroom proxy did not answer within ${timeoutMs}ms`));
    }, timeoutMs);
    start(controller.signal).then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (cause) => {
        clearTimeout(timer);
        reject(cause);
      },
    );
  });
}

/**
 * Drop content-length from the outgoing headers: the body is about to change
 * size, and a stale length would make the provider read a truncated request.
 * The production adapters never set it, but this seam is generic.
 */
function withoutContentLength(headers: HeadersInit | undefined): HeadersInit | undefined {
  if (!headers) return headers;
  if (headers instanceof Headers) {
    if (!headers.has("content-length")) return headers;
    const rest = new Headers(headers);
    rest.delete("content-length");
    return rest;
  }
  if (Array.isArray(headers)) return headers.filter(([name]) => name.toLowerCase() !== "content-length");
  const rest: Record<string, string> = { ...headers };
  for (const name of Object.keys(rest)) {
    if (name.toLowerCase() === "content-length") delete rest[name];
  }
  return rest;
}
