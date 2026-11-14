import { describe, expect, it } from "vitest";
import {
  canonicalVideoUrl,
  fetchTranscript,
  isYouTubeUrl,
  parseTimedText,
  parseVideoId,
  type FetchLike,
} from "@/integrations/youtube/transcript";

const ID = "dQw4w9WgXcQ";

describe("parseVideoId", () => {
  it("reads every documented URL shape", () => {
    expect(parseVideoId(`https://www.youtube.com/watch?v=${ID}`)).toBe(ID);
    expect(parseVideoId(`https://youtu.be/${ID}`)).toBe(ID);
    expect(parseVideoId(`https://youtu.be/${ID}?si=tracking`)).toBe(ID);
    expect(parseVideoId(`https://www.youtube.com/shorts/${ID}`)).toBe(ID);
    expect(parseVideoId(`https://www.youtube.com/embed/${ID}`)).toBe(ID);
    expect(parseVideoId(`https://m.youtube.com/watch?v=${ID}`)).toBe(ID);
    expect(parseVideoId(`https://music.youtube.com/watch?v=${ID}&list=RD`)).toBe(ID);
    expect(parseVideoId(`https://www.youtube-nocookie.com/embed/${ID}`)).toBe(ID);
    expect(parseVideoId(`https://www.youtube.com/live/${ID}`)).toBe(ID);
  });

  it("accepts a bare id", () => {
    expect(parseVideoId(ID)).toBe(ID);
  });

  it("rejects non-video addresses", () => {
    expect(parseVideoId("https://www.youtube.com/@channel")).toBeNull();
    expect(parseVideoId("https://example.com/watch?v=dQw4w9WgXcQ")).toBeNull();
    expect(parseVideoId("https://www.youtube.com/watch?v=short")).toBeNull();
    expect(parseVideoId("not a url")).toBeNull();
  });
});

describe("isYouTubeUrl", () => {
  it("is true for a URL and false for a bare id", () => {
    expect(isYouTubeUrl(`https://youtu.be/${ID}`)).toBe(true);
    expect(isYouTubeUrl(ID)).toBe(false);
  });
});

describe("canonicalVideoUrl", () => {
  it("collapses every shape to one stored form", () => {
    const forms = [
      `https://www.youtube.com/watch?v=${ID}`,
      `https://youtu.be/${ID}?si=abc`,
      `https://www.youtube.com/shorts/${ID}`,
      `https://www.youtube.com/watch?v=${ID}&t=42&feature=share`,
    ];
    const canonical = new Set(forms.map((u) => canonicalVideoUrl(parseVideoId(u)!)));
    expect([...canonical]).toEqual([`https://www.youtube.com/watch?v=${ID}`]);
  });
});

describe("parseTimedText", () => {
  it("parses WebVTT with a header, notes and inline tags", () => {
    const vtt = `WEBVTT
Kind: captions
Language: en

NOTE this is a comment

00:00:01.000 --> 00:00:03.500
Hello <i>there</i>

00:00:03.500 --> 00:00:06.000
<00:00:03.500><c>second</c> cue
`;
    const cues = parseTimedText(vtt);
    expect(cues).toHaveLength(2);
    expect(cues[0]).toEqual({ start: 1, duration: 2.5, text: "Hello there" });
    expect(cues[1].text).toBe("second cue");
  });

  it("parses SRT with comma milliseconds", () => {
    const srt = `1
00:00:10,250 --> 00:00:12,750
First line

2
00:00:12,750 --> 00:00:15,000
Second line
`;
    const cues = parseTimedText(srt);
    expect(cues).toHaveLength(2);
    expect(cues[0].start).toBe(10.25);
    expect(cues[1].text).toBe("Second line");
  });

  it("decodes entities", () => {
    const vtt = `WEBVTT

00:00:01.000 --> 00:00:02.000
Tom &amp; Jerry &lt;3
`;
    expect(parseTimedText(vtt)[0].text).toBe("Tom & Jerry <3");
  });

  it("parses YouTube's srv3 XML, joining word runs and skipping empty cues", () => {
    const cues = parseTimedText(XML);
    expect(cues).toHaveLength(2);
    expect(cues[0]).toEqual({ start: 0.4, duration: 4.28, text: "Hi. Welcome" });
    expect(cues[1]).toEqual({ start: 4.68, duration: 3.44, text: "So, it's here." });
  });

  it("parses legacy timedtext XML", () => {
    const cues = parseTimedText(
      '<timedtext><body><text start="1.5" dur="2.5">Hello &amp; goodbye</text></body></timedtext>',
    );
    expect(cues).toEqual([{ start: 1.5, duration: 2.5, text: "Hello & goodbye" }]);
  });

  it("returns nothing for a non-timed-text body", () => {
    expect(parseTimedText("<html><body>consent</body></html>")).toEqual([]);
    expect(parseTimedText("")).toEqual([]);
  });
});

type FakeFetch = FetchLike & { calls: string[] };

function fakeFetch(responses: Array<{ ok: boolean; status: number; body: string }>): FakeFetch {
  let i = 0;
  const calls: string[] = [];
  const fetchImpl = (async (input: string) => {
    calls.push(input);
    const r = responses[Math.min(i, responses.length - 1)];
    i += 1;
    return { ok: r.ok, status: r.status, text: async () => r.body };
  }) as FakeFetch;
  fetchImpl.calls = calls;
  return fetchImpl;
}

function playerBody(
  tracks: Array<{ url?: string; language?: string; kind?: string }>,
  extra: { status?: string; reason?: string; title?: string } = {},
): string {
  return JSON.stringify({
    playabilityStatus: { status: extra.status ?? "OK", ...(extra.reason ? { reason: extra.reason } : {}) },
    videoDetails: { title: extra.title ?? "A talk" },
    captions: {
      playerCaptionsTracklistRenderer: {
        captionTracks: tracks.map((track) => ({
          ...(track.url ? { baseUrl: track.url } : {}),
          ...(track.language ? { languageCode: track.language } : {}),
          ...(track.kind ? { kind: track.kind } : {}),
        })),
      },
    },
  });
}

const TRACK = `https://www.youtube.com/api/timedtext?v=${ID}&lang=en&signature=signed`;
const XML = `<timedtext format="3"><body><p t="400" d="4280"><s>Hi.</s><s t="720"> Welcome</s></p><p t="4680" d="3440"><s>So,</s><s t="120"> it&#39;s</s><s t="320"> here.</s></p></body></timedtext>`;

describe("fetchTranscript", () => {
  it("reads the signed caption track from the player response", async () => {
    const fetchImpl = fakeFetch([
      { ok: true, status: 200, body: playerBody([{ url: TRACK, language: "en", kind: "asr" }]) },
      { ok: true, status: 200, body: XML },
    ]);
    const out = await fetchTranscript(`https://youtu.be/${ID}?si=x`, { fetchImpl });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.videoId).toBe(ID);
    expect(out.canonicalUrl).toBe(canonicalVideoUrl(ID));
    expect(out.title).toBe("A talk");
    expect(out.language).toBe("en");
    expect(out.generated).toBe(true);
    expect(out.text).toBe("Hi. Welcome\nSo, it's here.");
    expect(out.cues).toHaveLength(2);
    expect(fetchImpl.calls).toEqual([
      "https://www.youtube.com/youtubei/v1/player?key=AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8",
      TRACK,
    ]);
  });

  it("prefers an authored track over an auto-generated one in the same language", async () => {
    const asr = `${TRACK}&kind=asr`;
    const authored = `${TRACK}&authored=1`;
    const fetchImpl = fakeFetch([
      {
        ok: true,
        status: 200,
        body: playerBody([
          { url: asr, language: "en", kind: "asr" },
          { url: authored, language: "en" },
        ]),
      },
      { ok: true, status: 200, body: XML },
    ]);
    const out = await fetchTranscript(ID, { fetchImpl });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.generated).toBe(false);
    expect(fetchImpl.calls[1]).toBe(authored);
  });

  it("falls back to the video's own language when English is absent", async () => {
    const track = `${TRACK}&lang=de`;
    const fetchImpl = fakeFetch([
      { ok: true, status: 200, body: playerBody([{ url: track, language: "de", kind: "asr" }]) },
      { ok: true, status: 200, body: XML },
    ]);
    const out = await fetchTranscript(ID, { fetchImpl });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.language).toBe("de");
  });

  it("treats a consent page as a failure, not an empty transcript", async () => {
    const fetchImpl = fakeFetch([
      { ok: true, status: 200, body: playerBody([{ url: TRACK, language: "en" }]) },
      { ok: true, status: 200, body: "<!doctype html><html>consent</html>" },
    ]);
    const out = await fetchTranscript(ID, { fetchImpl });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error).toMatch(/consent or error page/);
  });

  it("reports a non-200 player response as a stated failure", async () => {
    const out = await fetchTranscript(ID, {
      fetchImpl: fakeFetch([{ ok: false, status: 404, body: "" }]),
    });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error).toMatch(/404/);
  });

  it("reports a non-200 caption track as a stated failure", async () => {
    const fetchImpl = fakeFetch([
      { ok: true, status: 200, body: playerBody([{ url: TRACK, language: "en" }]) },
      { ok: false, status: 429, body: "" },
    ]);
    const out = await fetchTranscript(ID, { fetchImpl });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error).toMatch(/429/);
  });

  it("reports an empty track body as no captions", async () => {
    const fetchImpl = fakeFetch([
      { ok: true, status: 200, body: playerBody([{ url: TRACK, language: "en" }]) },
      { ok: true, status: 200, body: "" },
    ]);
    const out = await fetchTranscript(ID, { fetchImpl });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error).toMatch(/no captions/);
  });

  it("reports a video with no caption tracks as no captions", async () => {
    const out = await fetchTranscript(ID, {
      fetchImpl: fakeFetch([{ ok: true, status: 200, body: playerBody([]) }]),
    });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error).toMatch(/no captions/);
  });

  it("surfaces why a video cannot be played", async () => {
    const out = await fetchTranscript(ID, {
      fetchImpl: fakeFetch([
        {
          ok: true,
          status: 200,
          body: playerBody([], { status: "LOGIN_REQUIRED", reason: "Sign in to confirm your age" }),
        },
      ]),
    });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error).toMatch(/Sign in to confirm your age/);
  });

  it("marks the bot-check wall as blocked, so the caller does not retry it", async () => {
    const out = await fetchTranscript(ID, {
      fetchImpl: fakeFetch([
        {
          ok: true,
          status: 200,
          body: playerBody([], { status: "LOGIN_REQUIRED", reason: "Sign in to confirm you\u2019re not a bot" }),
        },
      ]),
    });
    expect(out).toMatchObject({ ok: false, blocked: true });
  });

  it("marks a 403 or 429 as blocked, but a 404 and a network failure as not", async () => {
    const refused = (status: number) => fetchTranscript(ID, { fetchImpl: fakeFetch([{ ok: false, status, body: "" }]) });
    expect(await refused(403)).toMatchObject({ ok: false, blocked: true });
    expect(await refused(429)).toMatchObject({ ok: false, blocked: true });
    expect(await refused(404)).not.toHaveProperty("blocked");
    expect(await refused(500)).not.toHaveProperty("blocked");
    const track = await fetchTranscript(ID, {
      fetchImpl: fakeFetch([
        { ok: true, status: 200, body: playerBody([{ url: TRACK, language: "en" }]) },
        { ok: false, status: 429, body: "" },
      ]),
    });
    expect(track).toMatchObject({ ok: false, blocked: true });
  });

  it("reports an unreadable player response", async () => {
    const out = await fetchTranscript(ID, {
      fetchImpl: fakeFetch([{ ok: true, status: 200, body: "<html>not json</html>" }]),
    });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error).toMatch(/unreadable player response/);
  });

  it("rejects a non-YouTube URL before fetching", async () => {
    let called = false;
    const out = await fetchTranscript("https://example.com/video", {
      fetchImpl: async () => {
        called = true;
        return { ok: true, status: 200, text: async () => "" };
      },
    });
    expect(out.ok).toBe(false);
    expect(called).toBe(false);
  });

  it("reports a network failure", async () => {
    const out = await fetchTranscript(ID, {
      fetchImpl: async () => {
        throw new TypeError("fetch failed");
      },
    });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error).toMatch(/could not be reached/);
  });
});
