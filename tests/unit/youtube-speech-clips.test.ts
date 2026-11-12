import { describe, expect, it } from "vitest";
import { clipCues, SPEECH_CLIP_SECONDS, speechClips } from "@/domains/knowledge/youtube-absorb";
import { groqWhisperCostMicroUsd } from "@/integrations/transcription/groq-whisper";

/*
 * Value: protects=how a video without captions is split for the paid
 * transcriber and what it costs; fails_when=clips overlap, leave a gap, run
 * past the video or exceed the clip length, speech cues lose their place in
 * the video, or the cost of an hour drifts from Groq's price; seam=the pure
 * clip plan, cue offset and price functions; no_claim=Groq itself.
 */

describe("speech clips", () => {
  it("covers the whole video in clips of at most twenty minutes, end to end", () => {
    expect(speechClips(0)).toEqual([]);
    expect(speechClips(90)).toEqual([{ from: 0, to: 90 }]);
    const hourAndAHalf = speechClips(5400);
    expect(hourAndAHalf).toHaveLength(5);
    expect(hourAndAHalf[0]).toEqual({ from: 0, to: SPEECH_CLIP_SECONDS });
    expect(hourAndAHalf.at(-1)).toEqual({ from: 4800, to: 5400 });
    for (const [i, clip] of hourAndAHalf.entries()) {
      expect(clip.to - clip.from).toBeLessThanOrEqual(SPEECH_CLIP_SECONDS);
      if (i > 0) expect(clip.from).toBe(hourAndAHalf[i - 1].to);
    }
  });

  it("puts a clip's speech back on the video's own clock", () => {
    expect(clipCues([{ start: 2.25, end: 5.5, text: "Hi." }], 1200)).toEqual([{ start: 1202.25, duration: 3.25, text: "Hi." }]);
  });

  it("prices speech at Groq's $0.04 an hour, with its ten second minimum", () => {
    expect(groqWhisperCostMicroUsd(3600)).toBe(40_000);
    expect(groqWhisperCostMicroUsd(1)).toBe(groqWhisperCostMicroUsd(10));
    expect(groqWhisperCostMicroUsd(3600) / 1_000_000).toBeLessThan(0.05);
  });
});
