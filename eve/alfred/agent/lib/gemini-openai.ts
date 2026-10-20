/*
 * Gemini's OpenAI-compatible endpoint returns tool calls the OpenAI schema
 * rejects, in two model-generation-specific ways:
 *
 *   gemini-2.5-flash     {"delta":{"tool_calls":[{"function":{...},"id":"…"}]}}
 *                        — no `index`.
 *   gemini-3.x-flash     {"delta":{"tool_calls":[{"extra_content":{"google":
 *                        {"thought_signature":"…"}},"function":{…},…}]}}
 *                        — no `index`, plus an unknown `extra_content` member.
 *
 * `@ai-sdk/openai` parses that chunk against the OpenAI delta schema and throws
 * `AI_TypeValidationError` (`invalid_union`), so any turn where the model calls a
 * tool fails before the tool ever runs. Measured, not assumed: the
 * chat-grounding eval failed with exactly that error on a real tool call against
 * both model generations.
 *
 * This module repairs the response at the HTTP boundary, which is the narrowest
 * place to do it: every later layer sees well-formed OpenAI chunks, and nothing
 * about eve, the agent, or the tools has to know Gemini is involved.
 *
 * Deliberately narrow:
 *  - only adds `index` to a tool-call delta that lacks one (a single call in a
 *    chunk is index 0, which is what Gemini emits);
 *  - passes every other chunk through byte-for-byte, including plain text and
 *    the non-streaming body;
 *  - is a no-op for a provider that already sends `index`, so it can wrap the
 *    model unconditionally.
 */

/** The narrow fetch signature both `createOpenAI` and the global accept. */
type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/**
 * Normalize one streaming chunk to the OpenAI delta schema: give each tool call
 * the `index` position it omitted. Returns the original object when nothing
 * needed changing.
 *
 * `extra_content` is preserved: it carries Gemini 3.x's `thought_signature`,
 * which must be echoed back on the next request's function-call part.
 */
export function withToolCallIndexes(chunk: unknown): unknown {
  if (typeof chunk !== "object" || chunk === null) return chunk;
  const choices = (chunk as { choices?: unknown }).choices;
  if (!Array.isArray(choices)) return chunk;

  let changed = false;
  const patchedChoices = choices.map((choice) => {
    if (typeof choice !== "object" || choice === null) return choice;
    const delta = (choice as { delta?: unknown }).delta;
    if (typeof delta !== "object" || delta === null) return choice;
    const toolCalls = (delta as { tool_calls?: unknown }).tool_calls;
    if (!Array.isArray(toolCalls)) return choice;

    let choiceChanged = false;
    const patchedCalls = toolCalls.map((call, position) => {
      if (typeof call !== "object" || call === null) return call;
      if (typeof (call as { index?: unknown }).index === "number") return call;
      choiceChanged = true;
      // A delta carries its own position within the chunk; when a chunk holds
      // one call, that is 0.
      return { ...(call as object), index: position };
    });
    if (!choiceChanged) return choice;
    changed = true;
    return { ...(choice as object), delta: { ...(delta as object), tool_calls: patchedCalls } };
  });
  return changed ? { ...(chunk as object), choices: patchedChoices } : chunk;
}

/** `extra_content.google.thought_signature` on a tool call, if present. */
function signatureOf(call: unknown): { callId: string; signature: string } | null {
  if (typeof call !== "object" || call === null) return null;
  const record = call as { id?: unknown; extra_content?: unknown };
  const id = typeof record.id === "string" ? record.id : null;
  const google = (record.extra_content as { google?: { thought_signature?: unknown } } | undefined)?.google;
  const signature = typeof google?.thought_signature === "string" ? google.thought_signature : null;
  return id && signature ? { callId: id, signature } : null;
}

/**
 * Thought signatures for Gemini 3.x tool calls, keyed by call id.
 *
 * Gemini requires the signature on the function-call part when the result comes
 * back. An OpenAI-shaped client rebuilds the assistant message from its own
 * schema and drops `extra_content`, so the follow-up request arrives without it
 * and the API rejects it: "Function call is missing a thought_signature in
 * functionCall parts". The shim therefore remembers each signature as it streams
 * past and puts it back on the request that carries that call's result.
 *
 * Scope: process-local and bounded. A signature is only needed between a tool
 * call and its result in the same run, which is the same process, and a run that
 * restarts re-issues the call. The cap stops an unbounded map in a long-lived
 * server: oldest entries fall out first, and a miss degrades to the API's own
 * error rather than to wrong data.
 */
const SIGNATURE_CAP = 512;
const signatures = new Map<string, string>();

function rememberSignature(callId: string, signature: string): void {
  if (signatures.size >= SIGNATURE_CAP) {
    const oldest = signatures.keys().next().value;
    if (oldest !== undefined) signatures.delete(oldest);
  }
  signatures.set(callId, signature);
}

/** Record every signature in a response body (streaming chunk or full message). */
function captureSignatures(body: unknown): void {
  if (typeof body !== "object" || body === null) return;
  const choices = (body as { choices?: unknown }).choices;
  if (!Array.isArray(choices)) return;
  for (const choice of choices) {
    if (typeof choice !== "object" || choice === null) continue;
    const delta = (choice as { delta?: { tool_calls?: unknown } }).delta;
    const message = (choice as { message?: { tool_calls?: unknown } }).message;
    for (const calls of [delta?.tool_calls, message?.tool_calls]) {
      if (!Array.isArray(calls)) continue;
      for (const call of calls) {
        const found = signatureOf(call);
        if (found) rememberSignature(found.callId, found.signature);
      }
    }
  }
}

/**
 * Put remembered signatures back on an outgoing request body. Mutates a copy and
 * returns it; the original body is left alone.
 */
export function withRememberedSignatures(body: unknown): unknown {
  if (typeof body !== "object" || body === null) return body;
  const messages = (body as { messages?: unknown }).messages;
  if (!Array.isArray(messages)) return body;

  let changed = false;
  const patched = messages.map((message) => {
    if (typeof message !== "object" || message === null) return message;
    const toolCalls = (message as { tool_calls?: unknown }).tool_calls;
    if (!Array.isArray(toolCalls) || toolCalls.length === 0) return message;

    let messageChanged = false;
    const calls = toolCalls.map((call) => {
      if (typeof call !== "object" || call === null) return call;
      const record = call as { id?: unknown; extra_content?: unknown };
      if (typeof record.id !== "string" || record.extra_content !== undefined) return call;
      const signature = signatures.get(record.id);
      if (signature === undefined) return call;
      messageChanged = true;
      return { ...record, extra_content: { google: { thought_signature: signature } } };
    });
    if (!messageChanged) return message;
    changed = true;
    return { ...(message as object), tool_calls: calls };
  });
  return changed ? { ...(body as object), messages: patched } : body;
}

/** Rewrite one SSE `data:` line, or return it untouched. */
function patchSseLine(line: string): string {
  const prefix = "data:";
  if (!line.startsWith(prefix)) return line;
  const payload = line.slice(prefix.length).trim();
  if (payload.length === 0 || payload === "[DONE]") return line;
  try {
    const parsed = JSON.parse(payload) as unknown;
    // Every streamed chunk may carry a signature, even one that needs no index.
    captureSignatures(parsed);
    const patched = withToolCallIndexes(parsed);
    if (patched === parsed) return line;
    return `${prefix} ${JSON.stringify(patched)}`;
  } catch {
    return line;
  }
}

/** Patch a streamed SSE body line by line, buffering across chunk boundaries. */
function patchEventStream(body: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        buffer += decoder.decode(chunk, { stream: true });
        const parts = buffer.split("\n");
        // Keep the unterminated tail: a data line can be split across chunks.
        buffer = parts.pop() ?? "";
        if (parts.length === 0) return;
        const rewritten = parts.map(patchSseLine).join("\n") + "\n";
        controller.enqueue(encoder.encode(rewritten));
      },
      flush(controller) {
        if (buffer.length === 0) return;
        controller.enqueue(encoder.encode(patchSseLine(buffer)));
        buffer = "";
      },
    }),
  );
}

/**
 * A fetch that repairs Gemini's OpenAI-compatible traffic in both directions:
 * re-attaches remembered thought signatures on the way out, and adds the missing
 * tool-call `index` on the way in. Compose with the provider:
 * `createOpenAI({ baseURL, apiKey, fetch: geminiFetch() })`.
 */
export function geminiFetch(base: Fetcher = fetch): Fetcher {
  return async (input, init) => {
    let outgoing = init;
    if (typeof init?.body === "string") {
      try {
        const parsed = JSON.parse(init.body) as unknown;
        const patched = withRememberedSignatures(parsed);
        if (patched !== parsed) outgoing = { ...init, body: JSON.stringify(patched) };
      } catch {
        // Not JSON (or not ours): send it as given.
      }
    }

    const response = await base(input, outgoing);
    const contentType = response.headers.get("content-type") ?? "";

    // A non-streamed completion still carries signatures for the next turn.
    if (contentType.includes("application/json")) {
      const text = await response.text();
      try {
        captureSignatures(JSON.parse(text));
      } catch {
        // Leave an unparseable body to the SDK, which reports it properly.
      }
      return new Response(text, { status: response.status, statusText: response.statusText, headers: response.headers });
    }

    if (!response.body || !contentType.includes("text/event-stream")) return response;
    return new Response(patchEventStream(response.body), {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
}
