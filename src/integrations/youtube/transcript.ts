/*
 * YouTube transcript transport.
 *
 * The only job here is: take a URL or id, return timed text plus a normalized
 * identity. It does not touch the database and it does not decide what to do
 * with a failure; callers record that.
 *
 * The public timedtext endpoint is unverified from this environment (no network
 * probe was possible), so the transport is injected and every parse is covered
 * by fixtures. A response that is not timed text — a consent wall, a 404, an
 * empty body — is a typed failure, never an empty transcript that looks like a
 * silent video.
 */

export type TranscriptCue = {
  /** Seconds from the start of the video. */
  start: number;
  duration: number;
  text: string;
};

export type TranscriptResult =
  | {
      ok: true;
      videoId: string;
      /** The one stored identity for this video, whatever URL shape arrived. */
      canonicalUrl: string;
      title: string | null;
      cues: TranscriptCue[];
      /** Plain text with one cue per line, which is what extraction reads. */
      text: string;
      language: string | null;
      generated: boolean;
    }
  | { ok: false; error: string };

export type FetchLike = (input: string, init?: { headers?: Record<string, string> }) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
}>;

const HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "music.youtube.com",
  "youtube-nocookie.com",
  "www.youtube-nocookie.com",
]);

/** Every URL shape the product accepts, reduced to one id or null. */
export function parseVideoId(raw: string): string | null {
  const trimmed = raw.trim();
  // A bare 11-character id is accepted so a paste of just the id works.
  if (/^[A-Za-z0-9_-]{11}$/.test(trimmed)) return trimmed;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  if (host === "youtu.be" || host === "www.youtu.be") {
    const id = url.pathname.split("/").filter(Boolean)[0];
    return isId(id) ? id : null;
  }
  if (!HOSTS.has(host)) return null;
  if (url.pathname === "/watch") {
    const id = url.searchParams.get("v");
    return isId(id) ? id : null;
  }
  // /shorts/<id>, /embed/<id>, /live/<id>, /v/<id>
  const match = /^\/(shorts|embed|live|v)\/([A-Za-z0-9_-]{11})(?:\/|$)/.exec(url.pathname);
  return match ? match[2] : null;
}

export function isYouTubeUrl(raw: string): boolean {
  return parseVideoId(raw) !== null && !/^[A-Za-z0-9_-]{11}$/.test(raw.trim());
}

function isId(value: string | null | undefined): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{11}$/.test(value);
}

/**
 * The single stored form. canonicalCaptureUrl does not strip YouTube's si, t,
 * feature or list parameters, so two shapes of the same video would otherwise
 * become two documents. Everything funnels through this.
 */
export function canonicalVideoUrl(videoId: string): string {
  return `https://www.youtube.com/watch?v=${videoId}`;
}

function decodeEntities(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
}

/**
 * Parses WebVTT or SRT into cues. Both formats differ only in the header and
 * the comma-vs-dot in the millisecond separator, so one parser covers them.
 */
export function parseTimedText(body: string): TranscriptCue[] {
  const text = body.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  const cues: TranscriptCue[] = [];
  const blocks = text.split(/\n{2,}/);
  const timing = /(\d{1,2}):(\d{2}):(\d{2})[.,](\d{3})\s*-->\s*(\d{1,2}):(\d{2}):(\d{2})[.,](\d{3})/;
  for (const block of blocks) {
    const lines = block.split("\n").filter((l) => l.trim() && !/^WEBVTT/i.test(l) && !/^(NOTE|Kind|Language):/i.test(l));
    if (lines.length === 0) continue;
    const timingIndex = lines.findIndex((l) => timing.test(l));
    if (timingIndex === -1) continue;
    const m = timing.exec(lines[timingIndex]);
    if (!m) continue;
    const start = toSeconds(m[1], m[2], m[3]) + Number(m[4]) / 1000;
    const end = toSeconds(m[5], m[6], m[7]) + Number(m[8]) / 1000;
    const payload = lines
      .slice(timingIndex + 1)
      .join(" ")
      // Inline timing tags and karaoke spans are noise, not speech.
      .replace(/<[^>]+>/g, "")
      .replace(/\{\\[^}]+\}/g, "")
      .trim();
    if (!payload) continue;
    cues.push({ start: round3(start), duration: round3(Math.max(0, end - start)), text: decodeEntities(payload) });
  }
  return cues;
}

function toSeconds(h: string, m: string, s: string): number {
  return Number(h) * 3600 + Number(m) * 60 + Number(s);
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/**
 * Fetches a transcript. `fetchImpl` is injected so the contract tests never
 * touch the network; production passes global fetch.
 *
 * A failure is one of: not a video URL, the endpoint returned non-200, or the
 * body is not timed text. The caller stores that reason.
 */
export async function fetchTranscript(
  rawUrl: string,
  options: { fetchImpl?: FetchLike; language?: string; timeoutMs?: number } = {},
): Promise<TranscriptResult> {
  const videoId = parseVideoId(rawUrl);
  if (!videoId) return { ok: false, error: "That is not a YouTube video address." };
  const canonicalUrl = canonicalVideoUrl(videoId);
  const language = options.language ?? "en";
  const fetchImpl = options.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);

  let body: string;
  try {
    const response = await withTimeout(
      fetchImpl(`https://www.youtube.com/api/timedtext?v=${videoId}&lang=${encodeURIComponent(language)}&fmt=vtt`, {
        headers: { "user-agent": "Mozilla/5.0 (compatible; Polymath/1.0)" },
      }),
      options.timeoutMs ?? 20_000,
    );
    if (!response.ok) {
      return { ok: false, error: `YouTube returned ${response.status} for this video.` };
    }
    body = await response.text();
  } catch (cause) {
    return { ok: false, error: cause instanceof Error && cause.name === "TimeoutError" ? "YouTube did not answer in time." : "YouTube could not be reached." };
  }

  // A consent wall or an HTML error page is not an empty transcript.
  if (/^\s*<(!doctype|html)/i.test(body)) {
    return { ok: false, error: "YouTube served a consent or error page instead of a transcript." };
  }
  const cues = parseTimedText(body);
  if (cues.length === 0) {
    return { ok: false, error: "This video has no captions available, or they are not in the requested language." };
  }

  return {
    ok: true,
    videoId,
    canonicalUrl,
    title: null,
    cues,
    text: cues.map((c) => c.text).join("\n"),
    language,
    generated: false,
  };
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(Object.assign(new Error("timeout"), { name: "TimeoutError" })), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
