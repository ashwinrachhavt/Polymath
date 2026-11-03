/*
 * OpenAI-compatible providers report some failures as an SSE `error` event on
 * an HTTP 200 response instead of a failing status. `@ai-sdk/openai` turns that
 * event into an APICallError whose statusCode defaults to 500, so the SDK reads
 * every such failure as a transient 5xx and retries it twice.
 *
 * Measured 2026-11-02 on Mercury 3: a content-filter refusal cost three
 * identical provider calls per turn, and the run recorded "Failed after 3
 * attempts" for a refusal that could not change. The non-streaming path returns
 * a real 400 for the same content and is correctly called once.
 *
 * This wrapper restores the status the provider omitted: an error event that
 * arrives before any output is replayed as a 400 response carrying the
 * provider's own error body on its way out, so the SDK classifies it as
 * non-retryable and the run fails once with the provider's message intact.
 *
 * A refusal that arrives after output has started cannot be replayed: the
 * headers are already sent. It streams through untouched.
 */

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/** How much of a stream to hold before deciding whether it failed to start. */
const PEEK_LIMIT_BYTES = 64 * 1024;

/** The provider's `{"error": ...}` payload when a chunk carries one. */
function errorPayloadOf(text: string): unknown {
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const payload = trimmed.slice("data:".length).trim();
    if (payload.length === 0 || payload === "[DONE]") continue;
    try {
      const parsed = JSON.parse(payload) as { error?: unknown };
      if (parsed && typeof parsed === "object" && "error" in parsed && parsed.error) return parsed.error;
    } catch {
      // A partial line is not an error payload; keep scanning.
    }
  }
  return null;
}

/** Whether a chunk holds model output, which means the stream is past its start. */
function hasOutput(text: string): boolean {
  return /"delta"\s*:\s*\{[^}]*"(content|tool_calls)"\s*:\s*(?!null)/.test(text);
}

/**
 * A fetch that gives provider-reported stream errors their real status.
 * Compose beneath the provider's `fetch` option, innermost of the wrappers.
 */
export function providerErrorGuardFetch(base: Fetcher = fetch): Fetcher {
  return async (input, init) => {
    const response = await base(input, init);
    const contentType = response.headers.get("content-type") ?? "";
    if (!response.body || !contentType.includes("text/event-stream")) return response;

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffered = "";
    let bytes = 0;

    // Read only until the answer starts or the stream ends.
    while (bytes < PEEK_LIMIT_BYTES) {
      const { done, value } = await reader.read();
      if (done) {
        buffered += decoder.decode();
        break;
      }
      buffered += decoder.decode(value, { stream: true });
      bytes += value.byteLength;
      const failure = errorPayloadOf(buffered);
      if (failure) {
        await reader.cancel();
        return Response.json({ error: failure }, { status: 400 });
      }
      if (hasOutput(buffered)) break;
    }

    const encoder = new TextEncoder();
    const replay = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(buffered));
      },
      async pull(controller) {
        const { done, value } = await reader.read();
        if (done) {
          controller.close();
          return;
        }
        controller.enqueue(value);
      },
      cancel(reason) {
        return reader.cancel(reason);
      },
    });

    return new Response(replay, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
}
