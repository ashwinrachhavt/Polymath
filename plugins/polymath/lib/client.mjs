const DEFAULT_URL = "http://localhost:3000";
const DEFAULT_TIMEOUT_MS = 30_000;

export class PolymathError extends Error {
  constructor(message, { status, code } = {}) {
    super(message);
    this.name = "PolymathError";
    this.status = status;
    this.code = code;
  }
}

/** @param {{ env?: Record<string, string | undefined>, fetch?: typeof globalThis.fetch, timeoutMs?: number }} [options] */
export function createClient({ env = process.env, fetch = globalThis.fetch, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const baseUrl = (env.POLYMATH_URL || DEFAULT_URL).replace(/\/+$/, "");
  const apiKey = env.POLYMATH_API_KEY;

  function assertConfigured() {
    if (!apiKey) {
      throw new PolymathError(
        "POLYMATH_API_KEY is not set. Create a key in Polymath under Settings > API keys, then set it in the plugin config or the POLYMATH_API_KEY environment variable.",
      );
    }
  }

  async function request(method, path, { query, body } = {}) {
    assertConfigured();
    const search = new URLSearchParams(Object.entries(query ?? {}).filter(([, value]) => value != null));
    const url = `${baseUrl}${path}${search.size ? `?${search}` : ""}`;
    let response;
    try {
      response = await fetch(url, {
        method,
        headers: {
          authorization: `Bearer ${apiKey}`,
          accept: "application/json",
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw new PolymathError(`Could not reach Polymath at ${baseUrl}.`);
    }
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      throw new PolymathError(payload?.title ?? `Polymath answered ${response.status}.`, {
        status: response.status,
        code: payload?.code,
      });
    }
    return payload;
  }

  return {
    baseUrl,
    assertConfigured,
    get: (path, query) => request("GET", path, { query }),
    post: (path, body) => request("POST", path, { body }),
  };
}
