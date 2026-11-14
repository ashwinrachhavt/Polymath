import { describe, expect, it } from "vitest";
// The extension ships plain scripts; the transcript decisions are exported for Node.
import Core from "../../extensions/chrome/youtube-transcript-core.js";
import { suppliedTranscriptSchema } from "@/domains/knowledge/youtube-transcript-schema";

/*
 * Value: protects=what the companion reads from a YouTube page and sends with
 * a capture; fails_when=a watch or shorts address is not read as one video id,
 * a player response with braces or quotes in its title is cut short, the wrong
 * caption track is picked, a json3 body or the transcript panel's rows do not
 * become cues on the video's clock, or the payload exceeds the bounds the
 * server refuses it at (a 422 the person never sees); seam=the pure core with
 * page-shaped fixtures, validated by the server's own schema; no_claim=the
 * content script's fetches and the live YouTube page (loaded by hand).
 */

const ID = "dQw4w9WgXcQ";

describe("videoIdFromUrl", () => {
  it("reads a watch or shorts address and nothing else", () => {
    expect(Core.videoIdFromUrl(`https://www.youtube.com/watch?v=${ID}&t=42s`)).toBe(ID);
    expect(Core.videoIdFromUrl(`https://m.youtube.com/watch?v=${ID}`)).toBe(ID);
    expect(Core.videoIdFromUrl(`https://www.youtube.com/shorts/${ID}`)).toBe(ID);
    expect(Core.videoIdFromUrl("https://www.youtube.com/@channel")).toBeNull();
    expect(Core.videoIdFromUrl(`https://example.com/watch?v=${ID}`)).toBeNull();
    expect(Core.videoIdFromUrl("not a url")).toBeNull();
  });
});

describe("playerResponseFromHtml", () => {
  it("reads the embedded object whole, even with braces and quotes in strings", () => {
    const player = { videoDetails: { title: 'A "talk" about {braces} \\ and more' }, captions: { n: 1 } };
    const html = `<script>var a=1;var ytInitialPlayerResponse = ${JSON.stringify(player)};var b={};</script>`;
    expect(Core.playerResponseFromHtml(html)).toEqual(player);
  });

  it("answers null for a page without one, or one that is cut off", () => {
    expect(Core.playerResponseFromHtml("<html></html>")).toBeNull();
    expect(Core.playerResponseFromHtml('<script>ytInitialPlayerResponse = {"a":')).toBeNull();
  });
});

describe("caption tracks", () => {
  const tracks = [
    { baseUrl: "https://x/fr", languageCode: "fr" },
    { baseUrl: "https://x/en-asr", languageCode: "en", kind: "asr" },
    { baseUrl: "https://x/en", languageCode: "en-US" },
  ];

  it("lists only tracks that have an address", () => {
    const player = {
      captions: { playerCaptionsTracklistRenderer: { captionTracks: [...tracks, { languageCode: "de" }] } },
    };
    expect(Core.captionTracksOf(player)).toHaveLength(3);
    expect(Core.captionTracksOf({})).toEqual([]);
  });

  it("prefers an authored track in the language, then auto-generated, then anything", () => {
    expect(Core.pickTrack(tracks, "en-GB").baseUrl).toBe("https://x/en");
    expect(Core.pickTrack(tracks.slice(0, 2), "en").baseUrl).toBe("https://x/en-asr");
    expect(Core.pickTrack(tracks, "de").baseUrl).toBe("https://x/fr");
    expect(Core.pickTrack([], "en")).toBeNull();
  });

  it("asks for json, keeping the signed query", () => {
    const url = new URL(Core.json3Url("https://www.youtube.com/api/timedtext?v=abc&sig=XYZ&lang=en"));
    expect(url.searchParams.get("fmt")).toBe("json3");
    expect(url.searchParams.get("sig")).toBe("XYZ");
  });
});

describe("cues", () => {
  it("reads a json3 body on the video's clock, joining segments and skipping empty events", () => {
    const body = JSON.stringify({
      events: [
        { tStartMs: 0, dDurationMs: 2500, segs: [{ utf8: "Hello" }, { utf8: " there" }] },
        { tStartMs: 2500, dDurationMs: 100, segs: [{ utf8: "\n" }] },
        { tStartMs: 62500, dDurationMs: 1500, segs: [{ utf8: "Second  minute." }] },
        { wpWinPosId: 1 },
      ],
    });
    expect(Core.cuesFromJson3(body)).toEqual([
      { start: 0, duration: 2.5, text: "Hello there" },
      { start: 62.5, duration: 1.5, text: "Second minute." },
    ]);
    expect(Core.cuesFromJson3("not json")).toEqual([]);
    expect(Core.cuesFromJson3("")).toEqual([]);
  });

  it("reads the transcript panel's rows, each running to the next, hours included", () => {
    expect(
      Core.cuesFromPanelRows([
        { time: "0:07", text: "First line" },
        { time: "1:02", text: "  Second   line " },
        { time: "1:01:05", text: "Last" },
        { time: "soon", text: "ignored" },
      ]),
    ).toEqual([
      { start: 7, duration: 55, text: "First line" },
      { start: 62, duration: 3603, text: "Second line" },
      { start: 3665, duration: 0, text: "Last" },
    ]);
  });
});

describe("buildTranscript", () => {
  const cues = [{ start: 1, duration: 2, text: "Hi." }];

  it("builds what the server accepts", () => {
    const payload = Core.buildTranscript({ videoId: ID, title: "A talk", language: "en", generated: true, cues });
    expect(suppliedTranscriptSchema.safeParse(payload).success).toBe(true);
    expect(payload).toMatchObject({ videoId: ID, title: "A talk", language: "en", generated: true });
  });

  it("sends nothing for a bad id or no usable cues", () => {
    expect(Core.buildTranscript({ videoId: "short", cues })).toBeNull();
    expect(Core.buildTranscript({ videoId: ID, cues: [{ start: 0, duration: 0, text: "  " }] })).toBeNull();
    expect(Core.buildTranscript({ videoId: ID, cues: [] })).toBeNull();
  });

  it("cuts an over-long transcript at the server's ceiling instead of sending one it will refuse", () => {
    const long = Array.from({ length: Core.MAX_CUES + 50 }, (_, i) => ({ start: i, duration: 1, text: "word" }));
    const payload = Core.buildTranscript({ videoId: ID, cues: long });
    expect(payload!.cues).toHaveLength(Core.MAX_CUES);
    expect(suppliedTranscriptSchema.safeParse(payload).success).toBe(true);
    const wide = Array.from({ length: 400 }, (_, i) => ({ start: i, duration: 1, text: "x".repeat(2000) }));
    const widePayload = Core.buildTranscript({ videoId: ID, cues: wide });
    expect(widePayload!.cues.length).toBeLessThan(400);
    expect(suppliedTranscriptSchema.safeParse(widePayload).success).toBe(true);
  });
});
