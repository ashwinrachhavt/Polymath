import { describe, expect, it } from "vitest";
import { FIXTURE_TRANSCRIPT } from "@/integrations/transcription/fixture";
import { transcriptionProvider } from "@/integrations/transcription/provider";

/*
 * ASH-298 selection contract: transcription is explicit opt-in only. No env
 * choice is the honest unconfigured error - never a silent key detection that
 * activates a live model, and never the fixture. "fixture" is deterministic
 * and free; "gemini" requires the key; anything else names the bad choice.
 */

describe("transcriptionProvider selection", () => {
  it("defaults to unconfigured: no TRANSCRIPTION_PROVIDER, no live model", () => {
    expect(() => transcriptionProvider({ GEMINI_API_KEY: "present" })).toThrowError(/No transcription provider configured/);
  });

  it("the fixture answers deterministically and only when explicitly chosen", async () => {
    const provider = transcriptionProvider({ TRANSCRIPTION_PROVIDER: "fixture" });
    expect(provider.registryId).toBe("fixture");
    const { text } = await provider.transcribe({ bytes: new Uint8Array([1, 2, 3]), mimeType: "audio/webm" });
    expect(text).toBe(FIXTURE_TRANSCRIPT);
  });

  it("gemini without a key is unconfigured, not a half-built adapter", () => {
    expect(() => transcriptionProvider({ TRANSCRIPTION_PROVIDER: "gemini" })).toThrowError(/No transcription provider configured/);
  });

  it("gemini with a key builds the named adapter", () => {
    const provider = transcriptionProvider({ TRANSCRIPTION_PROVIDER: "gemini", GEMINI_API_KEY: "k" });
    expect(provider.name).toBe("gemini:gemini-3.5-flash-lite");
    expect(provider.registryId).toBe("gemini");
  });

  it("an unknown provider names the choice in the refusal", () => {
    expect(() => transcriptionProvider({ TRANSCRIPTION_PROVIDER: "deepgram" })).toThrowError(/deepgram/);
  });
});
