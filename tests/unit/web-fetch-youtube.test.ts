import { describe, expect, it, vi } from "vitest";

/*
 * `web.fetch` on a YouTube URL must return the spoken content, not the page's
 * title/description/recommendation chrome. Firecrawl cannot see captions, so
 * the branch delegates to the transcript transport and renders the cues as
 * timestamped paragraphs.
 */

const { fetchTranscript } = vi.hoisted(() => ({ fetchTranscript: vi.fn() }));

vi.mock("@/integrations/youtube/transcript", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/integrations/youtube/transcript")>();
  return { ...original, fetchTranscript: (...args: unknown[]) => fetchTranscript(...args) };
});

import { fetchPageForAgent } from "@/domains/knowledge/web-fetch";

const ID = "dQw4w9WgXcQ";
const AUTH = { workspaceId: "workspace" };

function transcript(overrides: Record<string, unknown> = {}) {
  return {
    ok: true as const,
    videoId: ID,
    canonicalUrl: `https://www.youtube.com/watch?v=${ID}`,
    title: "A talk",
    cues: [
      { start: 0.4, duration: 3, text: "First cue." },
      { start: 31.2, duration: 3, text: "Second cue." },
    ],
    text: "First cue.\nSecond cue.",
    language: "en",
    generated: true,
    ...overrides,
  };
}

describe("fetchPageForAgent on YouTube", () => {
  it("renders the transcript with timestamps and video identity", async () => {
    fetchTranscript.mockResolvedValue(transcript());
    const result = await fetchPageForAgent(AUTH, { url: `https://youtu.be/${ID}?si=x` });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.title).toBe("A talk");
    expect(result.url).toBe(`https://www.youtube.com/watch?v=${ID}`);
    expect(result.markdown).toBe(
      [
        "# A talk",
        `https://www.youtube.com/watch?v=${ID}`,
        "Transcript: en (auto-generated)",
        "",
        "[0:00] First cue.",
        "[0:31] Second cue.",
      ].join("\n"),
    );
    expect(result.truncated).toBe(false);
    expect(fetchTranscript).toHaveBeenCalledWith(`https://youtu.be/${ID}?si=x`);
  });

  it("omits the heading and generated marker when absent", async () => {
    fetchTranscript.mockResolvedValue(transcript({ title: null, generated: false, language: "de" }));
    const result = await fetchPageForAgent(AUTH, { url: `https://www.youtube.com/watch?v=${ID}` });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.markdown).toContain("Transcript: de\n");
    expect(result.markdown).not.toContain("# ");
    expect(result.markdown).not.toContain("auto-generated");
  });

  it("passes a no-captions failure through instead of returning page chrome", async () => {
    fetchTranscript.mockResolvedValue({ ok: false, error: "This video has no captions available." });
    const result = await fetchPageForAgent(AUTH, { url: `https://www.youtube.com/watch?v=${ID}` });
    expect(result).toEqual({ ok: false, error: "This video has no captions available." });
  });

  it("truncates a long transcript at the caller's bound", async () => {
    fetchTranscript.mockResolvedValue(
      transcript({ cues: [{ start: 0, duration: 3, text: "x".repeat(2_000) }], text: "x".repeat(2_000) }),
    );
    const result = await fetchPageForAgent(AUTH, { url: `https://www.youtube.com/watch?v=${ID}`, maxChars: 1_000 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.truncated).toBe(true);
    expect(result.markdown).toHaveLength(1_000);
  });
});
