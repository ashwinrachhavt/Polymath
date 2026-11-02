import { afterEach, describe, expect, it, vi } from "vitest";
import { generationProvider } from "@/integrations/generation/provider";
import { HEADROOM_TIMEOUT_MS_DEFAULT, headroomEnabled, headroomFetch } from "@/integrations/headroom/client";

/*
 * The Headroom fetch wrapper (src/integrations/headroom/client.ts). Asserted
 * from the outside — what the provider's fetch receives and what the caller
 * gets back — because that is the contract both wired seams depend on:
 * gate off = byte-identical, gate on = compressed or failed open.
 */

const okCompletion = () => new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }));

const originalMessages = [{ role: "user", content: "tool output ".repeat(200) }];
const chatBody = () =>
  JSON.stringify({ model: "gemini-2.5-flash", messages: originalMessages, temperature: 0, stream: true });

interface RecordedCall {
  url: string;
  init: RequestInit;
}

/**
 * A fetch double that routes by URL: `/v1/compress` traffic goes to the
 * `compress` handler (the proxy side), everything else to `provider`.
 * Records every call either handler received.
 */
function routerFake(opts: {
  compress?: (init: RequestInit) => Promise<Response> | Response;
  provider?: (url: string, init: RequestInit) => Promise<Response> | Response;
}) {
  const calls: RecordedCall[] = [];
  const fetchMock: typeof fetch = async (input, init) => {
    const url = String(input);
    const recorded: RecordedCall = { url, init: init ?? {} };
    calls.push(recorded);
    if (url.includes("/v1/compress")) {
      if (!opts.compress) throw new Error("unexpected compress call");
      return await opts.compress(recorded.init);
    }
    if (!opts.provider) throw new Error("unexpected provider call");
    return await opts.provider(url, recorded.init);
  };
  return { calls, fetchMock };
}

describe("headroomFetch gate", () => {
  it("returns the caller's fetch itself when HEADROOM_BASE_URL is unset", () => {
    const fake = routerFake({}).fetchMock;
    // Identity, not an equivalent wrapper: nothing downstream can observe a
    // difference, which is what "byte-identical with the env unset" means.
    expect(headroomFetch({}, fake)).toBe(fake);
    expect(headroomFetch({ HEADROOM_BASE_URL: "" }, fake)).toBe(fake);
    expect(headroomFetch({ HEADROOM_BASE_URL: "   " }, fake)).toBe(fake);
  });

  it("reports enabled only when a base URL is actually set", () => {
    expect(headroomEnabled({})).toBe(false);
    expect(headroomEnabled({ HEADROOM_BASE_URL: "" })).toBe(false);
    expect(headroomEnabled({ HEADROOM_BASE_URL: "http://127.0.0.1:8787" })).toBe(true);
  });
});

describe("gate off through generationProvider", () => {
  it("hands the adapter the caller's fetch and makes no proxy call", async () => {
    const { calls, fetchMock } = routerFake({
      provider: () => okCompletion(),
    });
    const p = generationProvider({ MERCURY_API_KEY: "m" }, fetchMock);
    const out = await p.generate({ prompt: "hi" });
    expect(out.text).toBe("ok");

    // Exactly one network call — the provider's — carrying the adapter's own
    // body. A proxy round-trip here would be a gate leak.
    expect(calls).toHaveLength(1);
    const body = JSON.parse(String(calls[0].init.body)) as { messages: unknown[]; temperature: number };
    expect(Array.isArray(body.messages)).toBe(true);
    expect(body.temperature).toBe(0);
  });
});

describe("gate on — compression happy path", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("compresses the messages and preserves every other body field", async () => {
    const compressedMessages = [{ role: "system", content: "compressed" }];
    const { calls, fetchMock } = routerFake({
      compress: () =>
        new Response(
          JSON.stringify({
            messages: compressedMessages,
            tokens_before: 100,
            tokens_after: 3,
            tokens_saved: 97,
            compression_ratio: 0.03,
            transforms_applied: [],
            ccr_hashes: [],
          }),
        ),
      provider: () => okCompletion(),
    });
    const wrapped = headroomFetch({ HEADROOM_BASE_URL: "http://127.0.0.1:8787" }, fetchMock);

    const providerResponse = await wrapped("https://provider.example/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: chatBody(),
    });
    await expect(providerResponse.text()).resolves.toContain("ok");

    const [compressCall, providerCall] = calls;
    // The proxy got the original messages and the model (tokenizer selection).
    const sent = JSON.parse(String(compressCall.init.body)) as { messages: unknown[]; model: string };
    expect(sent.messages).toEqual(originalMessages);
    expect(sent.model).toBe("gemini-2.5-flash");
    // The provider got the compressed messages, everything else untouched.
    const forwarded = JSON.parse(String(providerCall.init.body)) as {
      messages: unknown[];
      model: string;
      temperature: number;
      stream: boolean;
    };
    expect(forwarded.messages).toEqual(compressedMessages);
    expect(forwarded.model).toBe("gemini-2.5-flash");
    expect(forwarded.temperature).toBe(0);
    expect(forwarded.stream).toBe(true);
  });

  it("sends the proxy token the way the SDK does when HEADROOM_API_KEY is set", async () => {
    const { calls, fetchMock } = routerFake({
      compress: () => new Response(JSON.stringify({ messages: originalMessages })),
      provider: () => okCompletion(),
    });
    const wrapped = headroomFetch(
      { HEADROOM_BASE_URL: "http://127.0.0.1:8787", HEADROOM_API_KEY: "secret-token" },
      fetchMock,
    );
    await wrapped("https://provider.example/v1/chat/completions", { method: "POST", body: chatBody() });

    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers["X-Headroom-Proxy-Token"]).toBe("secret-token");
    expect(headers["Authorization"]).toBe("Bearer secret-token");
  });

  it("omits the model from the compress body when the chat body has none", async () => {
    const { calls, fetchMock } = routerFake({
      compress: () => new Response(JSON.stringify({ messages: [] })),
      provider: () => okCompletion(),
    });
    const wrapped = headroomFetch({ HEADROOM_BASE_URL: "http://127.0.0.1:8787/" }, fetchMock);
    await wrapped("https://provider.example/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({ messages: [{ role: "user", content: "x" }] }),
    });

    const sent = JSON.parse(String(calls[0].init.body)) as Record<string, unknown>;
    expect("model" in sent).toBe(false);
  });

  it("drops a stale content-length and keeps the caller's headers and signal", async () => {
    const { calls, fetchMock } = routerFake({
      compress: () => new Response(JSON.stringify({ messages: [{ role: "user", content: "small" }] })),
      provider: () => okCompletion(),
    });
    const wrapped = headroomFetch({ HEADROOM_BASE_URL: "http://127.0.0.1:8787" }, fetchMock);
    const callerSignal = new AbortController().signal;
    await wrapped("https://provider.example/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": "99999" },
      body: chatBody(),
      signal: callerSignal,
    });

    const headers = calls[1].init.headers as Record<string, string>;
    expect(headers["content-length"]).toBeUndefined();
    expect(headers["Content-Length"]).toBeUndefined();
    expect(headers["Content-Type"]).toBe("application/json");
    // The provider call keeps the caller's own signal; only the compress
    // round-trip is bounded by HEADROOM_TIMEOUT_MS.
    expect(calls[1].init.signal).toBe(callerSignal);
  });
});

describe("gate on — fail-open", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("passes the original request through when the proxy is unreachable", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { calls, fetchMock } = routerFake({
      compress: () => Promise.reject(new Error("ECONNREFUSED")),
      provider: () => okCompletion(),
    });
    const wrapped = headroomFetch({ HEADROOM_BASE_URL: "http://127.0.0.1:8787" }, fetchMock);

    const response = await wrapped("https://provider.example/v1/chat/completions", {
      method: "POST",
      body: chatBody(),
    });
    await expect(response.text()).resolves.toContain("ok");

    // The provider saw the ORIGINAL body — the call proceeded uncompressed.
    const providerCall = calls.find((c) => !c.url.includes("/v1/compress"))!;
    expect(JSON.parse(String(providerCall.init.body)).messages).toEqual(originalMessages);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(String(errorSpy.mock.calls[0][0])).toContain("[headroom]");
  });

  it("passes the original request through on a proxy error status", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { calls, fetchMock } = routerFake({
      compress: () => new Response(JSON.stringify({ error: { type: "internal" } }), { status: 503 }),
      provider: () => okCompletion(),
    });
    const wrapped = headroomFetch({ HEADROOM_BASE_URL: "http://127.0.0.1:8787" }, fetchMock);

    await wrapped("https://provider.example/v1/chat/completions", { method: "POST", body: chatBody() });

    const providerCall = calls.find((c) => !c.url.includes("/v1/compress"))!;
    expect(JSON.parse(String(providerCall.init.body)).messages).toEqual(originalMessages);
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });

  it("honors HEADROOM_TIMEOUT_MS when the proxy hangs", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { calls, fetchMock } = routerFake({
      // Never settles: only the wrapper's timeout can end this round-trip.
      compress: () => new Promise<Response>(() => {}),
      provider: () => okCompletion(),
    });
    const wrapped = headroomFetch({ HEADROOM_BASE_URL: "http://127.0.0.1:8787", HEADROOM_TIMEOUT_MS: "25" }, fetchMock);

    const startedAt = performance.now();
    const response = await wrapped("https://provider.example/v1/chat/completions", {
      method: "POST",
      body: chatBody(),
    });
    const elapsedMs = performance.now() - startedAt;

    // The wrapper resolved (did not hang) on the timeout's back, and the
    // provider saw the original body.
    await expect(response.text()).resolves.toContain("ok");
    expect(elapsedMs).toBeGreaterThanOrEqual(20);
    const providerCall = calls.find((c) => !c.url.includes("/v1/compress"))!;
    expect(JSON.parse(String(providerCall.init.body)).messages).toEqual(originalMessages);
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });

  it("treats a compression_skipped proxy response as nothing to do", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { calls, fetchMock } = routerFake({
      // The proxy's own fail-open: 200, original messages, skip reason.
      compress: () =>
        new Response(
          JSON.stringify({ messages: originalMessages, compression_skipped: true, skip_reason: "compression_timeout" }),
        ),
      provider: () => okCompletion(),
    });
    const wrapped = headroomFetch({ HEADROOM_BASE_URL: "http://127.0.0.1:8787" }, fetchMock);

    await wrapped("https://provider.example/v1/chat/completions", { method: "POST", body: chatBody() });

    const providerCall = calls.find((c) => !c.url.includes("/v1/compress"))!;
    expect(String(providerCall.init.body)).toBe(chatBody());
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("logs and fails open on a malformed proxy response", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { calls, fetchMock } = routerFake({
      compress: () => new Response("<html>not json</html>"),
      provider: () => okCompletion(),
    });
    const wrapped = headroomFetch({ HEADROOM_BASE_URL: "http://127.0.0.1:8787" }, fetchMock);

    await wrapped("https://provider.example/v1/chat/completions", { method: "POST", body: chatBody() });

    const providerCall = calls.find((c) => !c.url.includes("/v1/compress"))!;
    expect(JSON.parse(String(providerCall.init.body)).messages).toEqual(originalMessages);
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });
});

describe("non-chat requests bypass compression entirely", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("passes a body without messages through without contacting the proxy", async () => {
    const { calls, fetchMock } = routerFake({ provider: () => okCompletion() });
    const wrapped = headroomFetch({ HEADROOM_BASE_URL: "http://127.0.0.1:8787" }, fetchMock);
    const embeddingsBody = JSON.stringify({ model: "text-embedding-3-small", input: "hello" });

    await wrapped("https://provider.example/v1/embeddings", { method: "POST", body: embeddingsBody });

    expect(calls).toHaveLength(1);
    expect(String(calls[0].init.body)).toBe(embeddingsBody);
  });

  it("passes a non-JSON body through without contacting the proxy", async () => {
    const { calls, fetchMock } = routerFake({ provider: () => okCompletion() });
    const wrapped = headroomFetch({ HEADROOM_BASE_URL: "http://127.0.0.1:8787" }, fetchMock);

    await wrapped("https://provider.example/v1/upload", { method: "POST", body: "raw-bytes-not-json" });

    expect(calls).toHaveLength(1);
    expect(String(calls[0].init.body)).toBe("raw-bytes-not-json");
  });
});

describe("gate on through generationProvider", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("compresses background generation traffic at the resolver seam", async () => {
    const compressedMessages = [{ role: "user", content: "crushed" }];
    const { calls, fetchMock } = routerFake({
      compress: () => new Response(JSON.stringify({ messages: compressedMessages })),
      provider: () => okCompletion(),
    });
    const p = generationProvider({ MERCURY_API_KEY: "m", HEADROOM_BASE_URL: "http://127.0.0.1:8787" }, fetchMock);
    const out = await p.generate({ prompt: "long prompt ".repeat(100) });
    expect(out.text).toBe("ok");

    expect(calls.find((c) => c.url.includes("/v1/compress"))).toBeDefined();
    const providerCall = calls.find((c) => !c.url.includes("/v1/compress"))!;
    const body = JSON.parse(String(providerCall.init.body)) as { messages: unknown[] };
    expect(body.messages).toEqual(compressedMessages);
  });
});

describe("timeout default", () => {
  it("is 1500ms per the spec", () => {
    expect(HEADROOM_TIMEOUT_MS_DEFAULT).toBe(1500);
  });
});
