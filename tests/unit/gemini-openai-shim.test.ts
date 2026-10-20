import { describe, expect, it } from "vitest";
import { geminiFetch, withRememberedSignatures, withToolCallIndexes } from "../../eve/alfred/agent/lib/gemini-openai";

/*
 * The Gemini OpenAI-compatibility shim. It exists because a real eval failed:
 * Gemini streams tool calls without `index`, and @ai-sdk/openai rejects that
 * chunk with AI_TypeValidationError, so every tool-using turn died before the
 * tool ran. These tests pin the repair and, just as importantly, that it leaves
 * everything else alone.
 */

describe("withToolCallIndexes", () => {
  it("adds the missing index to a streaming tool call", () => {
    const chunk = {
      choices: [
        {
          index: 0,
          delta: {
            role: "assistant",
            tool_calls: [{ function: { arguments: '{"query":"rent"}', name: "documents_search" }, id: "call-1", type: "function" }],
          },
          finish_reason: "tool_calls",
        },
      ],
    };
    const patched = withToolCallIndexes(chunk) as typeof chunk;
    expect(patched.choices[0].delta.tool_calls[0]).toMatchObject({ index: 0, id: "call-1" });
  });

  it("keeps extra_content in place", () => {
    // Gemini 3.x requires its thought_signature echoed back on the next
    // request. Dropping it makes the *following* turn fail with
    // "Function call is missing a thought_signature" — worse than the original
    // problem, and silent until the second turn. So the shim only adds `index`.
    const chunk = {
      choices: [
        {
          delta: {
            tool_calls: [
              { extra_content: { google: { thought_signature: "sig" } }, function: { name: "f" }, id: "c1" },
            ],
          },
          index: 0,
        },
      ],
    };
    const patched = withToolCallIndexes(chunk) as typeof chunk;
    const call = patched.choices[0].delta.tool_calls[0] as Record<string, unknown>;
    expect(call).toHaveProperty("extra_content");
    expect(call).toMatchObject({ index: 0 });
  });

  it("leaves a call that already has an index untouched, returning the same object", () => {
    const chunk = { choices: [{ delta: { tool_calls: [{ index: 2, id: "c" }] } }] };
    // Identity matters: needless copies would allocate on every text chunk.
    expect(withToolCallIndexes(chunk)).toBe(chunk);
  });

  it("leaves plain text chunks untouched", () => {
    const chunk = { choices: [{ delta: { content: "hello" } }] };
    expect(withToolCallIndexes(chunk)).toBe(chunk);
  });

  it("survives a chunk that is not shaped like a completion", () => {
    for (const value of [null, 42, "x", {}, { choices: "no" }, { choices: [null] }]) {
      expect(() => withToolCallIndexes(value)).not.toThrow();
    }
  });
});

describe("geminiFetch", () => {
  const sse = (lines: string[]) => lines.map((line) => `data: ${line}\n\n`).join("");

  function streamOf(text: string): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder();
    return new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(text));
        controller.close();
      },
    });
  }

  it("patches a streamed tool call end to end", async () => {
    const body = sse([
      JSON.stringify({ choices: [{ delta: { tool_calls: [{ id: "c1", type: "function", function: { name: "documents_search", arguments: "{}" } }] } }] }),
    ]) + "data: [DONE]\n\n";
    const fake: typeof fetch = async () =>
      new Response(streamOf(body), { headers: { "content-type": "text/event-stream" } });

    const response = await geminiFetch(fake)("https://x", {});
    const text = await response.text();
    expect(text).toContain('"index":0');
    expect(text).toContain("[DONE]");
  });

  it("reassembles a data line split across two chunks", async () => {
    // A chunk boundary can land mid-JSON; patching a partial line would corrupt it.
    const payload = JSON.stringify({ choices: [{ delta: { tool_calls: [{ id: "c1" }] } }] });
    const line = `data: ${payload}\n\n`;
    const cut = Math.floor(line.length / 2);
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(line.slice(0, cut)));
        controller.enqueue(encoder.encode(line.slice(cut)));
        controller.close();
      },
    });
    const fake: typeof fetch = async () => new Response(stream, { headers: { "content-type": "text/event-stream" } });
    const text = await (await geminiFetch(fake)("https://x", {})).text();
    expect(text).toContain('"index":0');
  });

  it("passes a non-streaming response straight through", async () => {
    const json = JSON.stringify({ choices: [{ message: { content: "hi" } }] });
    const fake: typeof fetch = async () => new Response(json, { headers: { "content-type": "application/json" } });
    const response = await geminiFetch(fake)("https://x", {});
    expect(await response.text()).toBe(json);
  });

  it("captures a signature from a response and re-attaches it on the next request", async () => {
    // The whole point of the round trip: Gemini 3.x rejects a tool-result
    // follow-up that does not echo the signature back.
    const callId = `call_roundtrip_${Date.now()}`;
    const body = sse([
      JSON.stringify({
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  extra_content: { google: { thought_signature: "sig-abc" } },
                  function: { name: "documents_search", arguments: "{}" },
                  id: callId,
                  type: "function",
                },
              ],
            },
          },
        ],
      }),
    ]);
    const fake: typeof fetch = async () =>
      new Response(streamOf(body), { headers: { "content-type": "text/event-stream" } });
    await (await geminiFetch(fake)("https://x", {})).text();

    const outgoing = withRememberedSignatures({
      messages: [
        { role: "assistant", tool_calls: [{ id: callId, type: "function", function: { name: "documents_search", arguments: "{}" } }] },
        { role: "tool", tool_call_id: callId, content: "[]" },
      ],
    }) as { messages: { tool_calls: { extra_content?: unknown }[] }[] };
    expect(outgoing.messages[0].tool_calls[0]).toMatchObject({
      extra_content: { google: { thought_signature: "sig-abc" } },
    });
  });

  it("leaves a request untouched when no signature is known", () => {
    const body = { messages: [{ role: "assistant", tool_calls: [{ id: "unknown-call", type: "function" }] }] };
    // Identity, so the common no-tool path allocates nothing extra.
    expect(withRememberedSignatures(body)).toBe(body);
  });

  it("geminiFetch itself re-attaches the signature on the follow-up request", async () => {
    /*
     * Value card
     * protects: the request side of the shim — the half that makes a tool-using
     *   turn survive past its first model call. Gemini rejects a tool result
     *   whose assistant message lost `extra_content`.
     * fails_when: `geminiFetch` captures signatures from the response but never
     *   applies them to the outgoing body (the code calls
     *   `withRememberedSignatures` on the parsed body), so every tool follow-up
     *   fails with "missing a thought_signature" while a direct unit test of
     *   the helper still passes.
     * why_new: the round-trip test above exercises `withRememberedSignatures`
     *   directly, which proves the helper and not that the fetch shim wires it
     *   into the request path — the seam that actually broke in production.
     * seam: `geminiFetch` composed with a fake base fetch, observing the body
     *   the base fetch receives.
     */
    const callId = `call_shim_${Date.now()}`;
    const capture = sse([
      JSON.stringify({
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  extra_content: { google: { thought_signature: "sig-shim" } },
                  function: { name: "documents_search", arguments: "{}" },
                  id: callId,
                  type: "function",
                },
              ],
            },
          },
        ],
      }),
    ]);
    const seen: Array<Record<string, unknown>> = [];
    const fake: typeof fetch = async (_input, init) => {
      if (typeof init?.body === "string") seen.push(JSON.parse(init.body) as Record<string, unknown>);
      return new Response(streamOf(capture), { headers: { "content-type": "text/event-stream" } });
    };
    const shimmed = geminiFetch(fake);

    // Turn 1: the model calls a tool; the shim captures the signature.
    await (await shimmed("https://gemini.test/chat/completions", { method: "POST", body: JSON.stringify({ messages: [] }) })).text();

    // Turn 2: the tool result goes back. The assistant message the SDK rebuilt
    // has no `extra_content`, so only the shim can restore it.
    const followUp = {
      messages: [
        { role: "assistant", tool_calls: [{ id: callId, type: "function", function: { name: "documents_search", arguments: "{}" } }] },
        { role: "tool", tool_call_id: callId, content: "[]" },
      ],
    };
    await (await shimmed("https://gemini.test/chat/completions", { method: "POST", body: JSON.stringify(followUp) })).text();

    expect(seen).toHaveLength(2);
    const sent = seen[1].messages as Array<{ tool_calls?: Array<Record<string, unknown>> }>;
    expect(sent[0].tool_calls?.[0]).toMatchObject({
      extra_content: { google: { thought_signature: "sig-shim" } },
    });
  });
});
