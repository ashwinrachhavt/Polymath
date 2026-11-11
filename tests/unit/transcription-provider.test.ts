import { describe, expect, it } from "vitest";
import { FIXTURE_TRANSCRIPT } from "@/integrations/transcription/fixture";
import { assertProviderUsable, providerEntry, quotaAllowance } from "@/integrations/providers/registry";
import { TranscriptionRequestError, transcriptionProvider } from "@/integrations/transcription/provider";

/*
 * ASH-298 selection contract: transcription is explicit opt-in only. No env
 * choice is the honest unconfigured error - never a silent key detection that
 * activates a live model, and never the fixture. "fixture" is deterministic
 * and free; "gemini" requires the key; anything else names the bad choice.
 */

describe("transcriptionProvider selection", () => {
  it("defaults to unconfigured: no TRANSCRIPTION_PROVIDER, no live model", () => {
    expect(() => transcriptionProvider({ GEMINI_API_KEY: "present" })).toThrowError(
      /No transcription provider configured/,
    );
  });

  it("the fixture answers deterministically and only when explicitly chosen", async () => {
    const provider = transcriptionProvider({ TRANSCRIPTION_PROVIDER: "fixture" });
    expect(provider.registryId).toBe("fixture");
    const { text } = await provider.transcribe({ bytes: new Uint8Array([1, 2, 3]), mimeType: "audio/webm" });
    expect(text).toBe(FIXTURE_TRANSCRIPT);
  });

  it("gemini without a key is unconfigured, not a half-built adapter", () => {
    expect(() => transcriptionProvider({ TRANSCRIPTION_PROVIDER: "gemini" })).toThrowError(
      /No transcription provider configured/,
    );
  });

  it("gemini with a key builds the named adapter", () => {
    const provider = transcriptionProvider({ TRANSCRIPTION_PROVIDER: "gemini", GEMINI_API_KEY: "k" });
    expect(provider.name).toBe("gemini:gemini-3.5-flash-lite");
    expect(provider.registryId).toBe("gemini");
  });

  it("an unknown provider names the choice in the refusal", () => {
    expect(() => transcriptionProvider({ TRANSCRIPTION_PROVIDER: "whisper" })).toThrowError(/whisper/);
  });

  it("gemini and the fixture reserve and use one request", async () => {
    const input = { bytes: new Uint8Array(100_000), mimeType: "audio/webm" };
    const gemini = transcriptionProvider({ TRANSCRIPTION_PROVIDER: "gemini", GEMINI_API_KEY: "k" });
    expect(gemini.reserveUnits(input)).toBe(1);
    const fixture = transcriptionProvider({ TRANSCRIPTION_PROVIDER: "fixture" });
    expect(fixture.reserveUnits(input)).toBe(1);
    expect((await fixture.transcribe(input)).units).toBe(1);
  });
});

describe("deepgram transcription", () => {
  const input = { bytes: new Uint8Array(10_000), mimeType: "audio/webm" };
  const body = (transcript: string, duration: number) => ({
    metadata: { duration },
    results: { channels: [{ alternatives: [{ transcript }] }] },
  });
  const withFetch = (respond: (url: string, init: RequestInit) => Response) => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return respond(url, init);
    }) as unknown as typeof fetch;
    const provider = transcriptionProvider(
      { TRANSCRIPTION_PROVIDER: "deepgram", DEEPGRAM_API_KEY: "secret" },
      fetchImpl,
    );
    return { provider, calls };
  };

  it("returns the transcript and the duration rounded up to whole seconds", async () => {
    const { provider, calls } = withFetch(() => Response.json(body("hello world", 4.2)));
    expect(provider.name).toBe("deepgram:nova-3");
    expect(provider.registryId).toBe("deepgram");
    expect(await provider.transcribe(input)).toEqual({ text: "hello world", units: 5 });
    const url = new URL(calls[0].url);
    expect(url.origin + url.pathname).toBe("https://api.deepgram.com/v1/listen");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      model: "nova-3",
      language: "en",
      smart_format: "true",
      mip_opt_out: "true",
    });
    expect(calls[0].init.method).toBe("POST");
    expect(calls[0].init.headers).toEqual({ Authorization: "Token secret", "Content-Type": "audio/webm" });
    expect(calls[0].init.body).toBe(input.bytes);
  });

  it("honours DEEPGRAM_MODEL", async () => {
    const calls: string[] = [];
    const provider = transcriptionProvider(
      { TRANSCRIPTION_PROVIDER: "deepgram", DEEPGRAM_API_KEY: "k", DEEPGRAM_MODEL: "nova-2" },
      (async (url: string) => {
        calls.push(url);
        return Response.json(body("x", 1));
      }) as unknown as typeof fetch,
    );
    await provider.transcribe(input);
    expect(provider.name).toBe("deepgram:nova-2");
    expect(new URL(calls[0]).searchParams.get("model")).toBe("nova-2");
  });

  it("returns an empty transcript for silence and still bills at least one second", async () => {
    const { provider } = withFetch(() => Response.json(body("", 0)));
    expect(await provider.transcribe(input)).toEqual({ text: "", units: 1 });
  });

  it("reserves an upper bound from the byte size, never less than one second", () => {
    const { provider } = withFetch(() => Response.json(body("", 0)));
    expect(provider.reserveUnits({ bytes: new Uint8Array(40_000), mimeType: "audio/webm" })).toBe(20);
    expect(provider.reserveUnits({ bytes: new Uint8Array(1), mimeType: "audio/webm" })).toBe(1);
  });

  it("a non-2xx response is a request error carrying the status", async () => {
    const { provider } = withFetch(() => new Response("nope", { status: 402 }));
    await expect(provider.transcribe(input)).rejects.toMatchObject({
      name: "TranscriptionRequestError",
      provider: "deepgram",
      status: 402,
    });
  });

  it("a malformed body is a request error, never an empty transcript", async () => {
    for (const payload of [
      {},
      { metadata: { duration: 3 }, results: { channels: [] } },
      { results: body("x", 1).results },
    ]) {
      const { provider } = withFetch(() => Response.json(payload));
      await expect(provider.transcribe(input)).rejects.toBeInstanceOf(TranscriptionRequestError);
    }
    const { provider } = withFetch(() => new Response("not json", { status: 200 }));
    await expect(provider.transcribe(input)).rejects.toBeInstanceOf(TranscriptionRequestError);
  });

  it("without a key it is unconfigured", () => {
    expect(() => transcriptionProvider({ TRANSCRIPTION_PROVIDER: "deepgram" })).toThrowError(
      /No transcription provider configured/,
    );
  });
});

describe("deepgram registry entry", () => {
  it("is usable and its allowance follows DEEPGRAM_LIFETIME_SECONDS", () => {
    const entry = assertProviderUsable(providerEntry("deepgram"), "test");
    expect(entry.quota).toMatchObject({ unit: "seconds", renewal: "lifetime" });
    expect(quotaAllowance(entry, {})).toBe(720_000);
    expect(quotaAllowance(entry, { DEEPGRAM_LIFETIME_SECONDS: "3600" })).toBe(3600);
  });
});
