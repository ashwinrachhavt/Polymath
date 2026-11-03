import { describe, expect, it } from "vitest";
import { providerErrorGuardFetch } from "../../eve/polymath/agent/lib/provider-error-guard";

/*
 * A provider that reports a refusal as an SSE `error` event on an HTTP 200 is
 * the shape Mercury 3 returned on 2026-11-02. The SDK read it as a default-500
 * APICallError, so every such refusal cost three identical provider calls.
 * These assertions are the contract that stops that: the refusal becomes a 400
 * the SDK will not retry, and a healthy stream is delivered byte for byte.
 */

const encoder = new TextEncoder();

function sseResponse(chunks: string[]): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function fetchReturning(response: Response): typeof fetch {
  return async () => response;
}

const REFUSAL =
  'data: {"error":{"message":"I\'m sorry, but I can\'t help with this because it involves potentially dangerous or harmful content.","type":"content_filter_error","param":null,"code":"content_filter"}}\n\ndata: [DONE]\n\n';

const HEALTHY = [
  'data: {"choices":[{"index":0,"delta":{"content":"Here is the draft"}}]}\n\n',
  'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
  "data: [DONE]\n\n",
];

describe("providerErrorGuardFetch", () => {
  it("turns a pre-output stream error into a non-retryable 400 carrying the provider's body", async () => {
    const guard = providerErrorGuardFetch(fetchReturning(sseResponse([REFUSAL])));
    const response = await guard("https://provider.invalid/chat/completions", { method: "POST" });

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("content_filter");
    expect(body.error.message).toContain("can't help");
  });

  it("passes a healthy stream through unchanged", async () => {
    const guard = providerErrorGuardFetch(fetchReturning(sseResponse(HEALTHY)));
    const response = await guard("https://provider.invalid/chat/completions", { method: "POST" });

    expect(response.status).toBe(200);
    expect(await response.text()).toBe(HEALTHY.join(""));
  });

  it("delivers output that arrives before any error, rather than swallowing it", async () => {
    const partial = [
      'data: {"choices":[{"index":0,"delta":{"content":"Partial answer"}}]}\n\n',
      'data: {"error":{"code":"server_error","message":"upstream died"}}\n\n',
    ];
    const guard = providerErrorGuardFetch(fetchReturning(sseResponse(partial)));
    const response = await guard("https://provider.invalid/chat/completions", { method: "POST" });

    // Headers are already sent once output starts, so the stream is replayed as-is.
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(partial.join(""));
  });

  it("leaves a non-SSE response untouched", async () => {
    const json = Response.json({ choices: [] }, { status: 200 });
    const guard = providerErrorGuardFetch(fetchReturning(json));
    const response = await guard("https://provider.invalid/chat/completions", { method: "POST" });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ choices: [] });
  });
});
