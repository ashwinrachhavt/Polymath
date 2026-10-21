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

  it("returns nothing for a non-timed-text body", () => {
    expect(parseTimedText("<html><body>consent</body></html>")).toEqual([]);
    expect(parseTimedText("")).toEqual([]);
  });
});

function fakeFetch(responses: Array<{ ok: boolean; status: number; body: string }>): FetchLike {
  let i = 0;
  return async () => {
    const r = responses[Math.min(i, responses.length - 1)];
    i += 1;
    return { ok: r.ok, status: r.status, text: async () => r.body };
  };
}

describe("fetchTranscript", () => {
  it("returns cues and the canonical url", async () => {
    const out = await fetchTranscript(`https://youtu.be/${ID}?si=x`, {
      fetchImpl: fakeFetch([{ ok: true, status: 200, body: "WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nHello\n" }]),
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.videoId).toBe(ID);
    expect(out.canonicalUrl).toBe(canonicalVideoUrl(ID));
    expect(out.text).toBe("Hello");
    expect(out.cues).toHaveLength(1);
  });

  it("treats a consent page as a failure, not an empty transcript", async () => {
    const out = await fetchTranscript(ID, {
      fetchImpl: fakeFetch([{ ok: true, status: 200, body: "<!doctype html><html>consent</html>" }]),
    });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error).toMatch(/consent or error page/);
  });

  it("reports a non-200 as a stated failure", async () => {
    const out = await fetchTranscript(ID, {
      fetchImpl: fakeFetch([{ ok: false, status: 404, body: "" }]),
    });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error).toMatch(/404/);
  });

  it("reports an empty body as no captions", async () => {
    const out = await fetchTranscript(ID, {
      fetchImpl: fakeFetch([{ ok: true, status: 200, body: "" }]),
    });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error).toMatch(/no captions/);
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
