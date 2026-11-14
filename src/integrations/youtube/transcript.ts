/*
 * YouTube transcript transport.
 *
 * The only job here is: take a URL or id, return timed text plus a normalized
 * identity. It does not touch the database and it does not decide what to do
 * with a failure; callers record that.
 *
 * The standalone `api/timedtext?v=…&lang=…` URL is no longer enough: for most
 * videos it answers 200 with an empty body because the track must be requested
 * through the player response's signed `baseUrl`. So the transport asks the
 * InnerTube player endpoint for the caption track list, picks the requested
 * language, then reads that track. This is the same two-step the public
 * transcript libraries use and needs no account or OAuth.
 *
 * The transport is injected and every parse is covered by fixtures. A response
 * that is not timed text — a consent wall, a 404, an empty body — is a typed
 * failure, never an empty transcript that looks like a silent video.
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
  /**
   * `blocked` is set when YouTube refused this server itself (a bot check, or a
   * 4xx other than not-found): another try from the same place cannot help, and
   * the caller should say so instead of retrying.
   */
  | { ok: false; error: string; blocked?: true };

export type FetchLike = (
  input: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  },
) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
}>;

/*
 * InnerTube is the API behind youtube.com itself. The key below is the public
 * web key shipped in every page, not a secret; the ANDROID client is used
 * because its player response carries caption tracks whose `baseUrl` still
 * serves timed text (the WEB client's default track is a "gemini" variant that
 * can answer empty). No login or API key of the owner's is involved.
 */
const INNERTUBE_PLAYER_URL = "https://www.youtube.com/youtubei/v1/player?key=AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8";
const ANDROID_USER_AGENT = "com.google.android.youtube/20.10.38 (Linux; U; Android 11) gzip";

type CaptionTrack = {
  baseUrl?: string;
  languageCode?: string;
  kind?: string;
};

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

type XmlCueShape = {
  tag: string;
  startAttr: string;
  durationAttr: string;
  /** Divisor from the attribute's unit to seconds. */
  scale: number;
  /** srv3 wraps the words of a cue in `<s>`; join them to keep reading order. */
  segments: boolean;
};

const SRV3: XmlCueShape = { tag: "p", startAttr: "t", durationAttr: "d", scale: 1 / 1000, segments: true };
const LEGACY: XmlCueShape = { tag: "text", startAttr: "start", durationAttr: "dur", scale: 1, segments: false };

/**
 * Parses one YouTube timedtext XML shape. srv3 puts each displayed cue in a
 * `<p t="ms" d="ms">`; the older shape uses `<text start="s" dur="s">`.
 */
function parseXmlCues(body: string, shape: XmlCueShape): TranscriptCue[] {
  const cues: TranscriptCue[] = [];
  const block = new RegExp(`<${shape.tag}\\s+([^>]*)>([\\s\\S]*?)</${shape.tag}>`, "g");
  const startAttr = new RegExp(`\\b${shape.startAttr}="([\\d.]+)"`);
  const durationAttr = new RegExp(`\\b${shape.durationAttr}="([\\d.]+)"`);
  for (const match of body.matchAll(block)) {
    const attrs = match[1];
    const startValue = Number(startAttr.exec(attrs)?.[1] ?? NaN);
    if (!Number.isFinite(startValue)) continue;
    const durationValue = Number(durationAttr.exec(attrs)?.[1] ?? NaN);
    const inner = match[2];
    const runs = shape.segments ? [...inner.matchAll(/<s\b[^>]*>([\s\S]*?)<\/s>/g)].map((s) => s[1]) : [];
    const payload = decodeEntities((runs.length > 0 ? runs.join("") : inner).replace(/<[^>]+>/g, ""))
      .replace(/\s+/g, " ")
      .trim();
    if (!payload) continue;
    cues.push({
      start: round3(startValue * shape.scale),
      duration: round3(Number.isFinite(durationValue) ? durationValue * shape.scale : 0),
      text: payload,
    });
  }
  return cues;
}

/**
 * Parses WebVTT, SRT or YouTube's timedtext XML into one cue shape. VTT and
 * SRT differ only in the header and the comma-vs-dot in the millisecond
 * separator, so one parser covers them; the XML shapes get their own pass.
 */
export function parseTimedText(body: string): TranscriptCue[] {
  if (/<timedtext|<text\s+[^>]*start=|<p\s+[^>]*\bt=/.test(body)) {
    const cues = parseXmlCues(body, SRV3);
    return cues.length > 0 ? cues : parseXmlCues(body, LEGACY);
  }
  const text = body.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  const cues: TranscriptCue[] = [];
  const blocks = text.split(/\n{2,}/);
  const timing = /(\d{1,2}):(\d{2}):(\d{2})[.,](\d{3})\s*-->\s*(\d{1,2}):(\d{2}):(\d{2})[.,](\d{3})/;
  for (const block of blocks) {
    const lines = block
      .split("\n")
      .filter((l) => l.trim() && !/^WEBVTT/i.test(l) && !/^(NOTE|Kind|Language):/i.test(l));
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

type PlayerResponse = {
  playabilityStatus?: { status?: string; reason?: string };
  videoDetails?: { title?: string };
  captions?: {
    playerCaptionsTracklistRenderer?: { captionTracks?: CaptionTrack[] };
  };
};

/**
 * Picks the best track for the requested language: an authored track over an
 * auto-generated one in the same language, then the requested language, then
 * whatever the video offers. A video whose speech is not English still yields
 * its own transcript instead of a "no captions" failure.
 */
function pickCaptionTrack(tracks: CaptionTrack[], language: string): CaptionTrack | null {
  const usable = tracks.filter((track) => typeof track.baseUrl === "string" && track.baseUrl.length > 0);
  if (usable.length === 0) return null;
  const wanted = language.toLowerCase().split("-")[0];
  const matching = usable.filter((track) => (track.languageCode ?? "").toLowerCase().split("-")[0] === wanted);
  return matching.find((track) => track.kind !== "asr") ?? matching[0] ?? usable[0];
}

/**
 * Fetches a transcript. `fetchImpl` is injected so the contract tests never
 * touch the network; production passes global fetch.
 *
 * Two requests: the player response supplies the signed caption-track URL, then
 * that track supplies timed text. A failure is one of: not a video URL, an
 * unavailable video, no caption track, a non-200, or a body that is not timed
 * text. The caller stores that reason.
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
  const timeoutMs = options.timeoutMs ?? 20_000;
  const networkFailure = (cause: unknown): string =>
    cause instanceof Error && cause.name === "TimeoutError"
      ? "YouTube did not answer in time."
      : "YouTube could not be reached.";

  // Step 1: the player response carries the signed caption-track URLs. The bare
  // timedtext URL has no signature and answers 200 with an empty body.
  let playerBody: string;
  try {
    const response = await withTimeout(
      fetchImpl(INNERTUBE_PLAYER_URL, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "user-agent": ANDROID_USER_AGENT,
          "accept-language": language,
        },
        body: JSON.stringify({
          context: {
            client: {
              clientName: "ANDROID",
              clientVersion: "20.10.38",
              androidSdkVersion: 30,
              hl: language,
              gl: "US",
            },
          },
          videoId,
          contentCheckOk: true,
          racyCheckOk: true,
        }),
      }),
      timeoutMs,
    );
    if (!response.ok) {
      return { ok: false, error: `YouTube returned ${response.status} for this video.`, ...refused(response.status) };
    }
    playerBody = await response.text();
  } catch (cause) {
    return { ok: false, error: networkFailure(cause) };
  }

  let player: PlayerResponse;
  try {
    player = JSON.parse(playerBody) as PlayerResponse;
  } catch {
    return { ok: false, error: "YouTube returned an unreadable player response." };
  }
  const playability = player.playabilityStatus;
  if (playability?.status && playability.status !== "OK") {
    return {
      ok: false,
      error: playability.reason
        ? `YouTube cannot play this video: ${playability.reason}`
        : "This video is not available.",
      ...(isBotCheck(playability) ? { blocked: true as const } : {}),
    };
  }

  const tracks = player.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? [];
  const track = pickCaptionTrack(tracks, language);
  if (!track?.baseUrl) {
    return { ok: false, error: "This video has no captions available." };
  }

  // Step 2: the signed track URL. Its default body is srv3 XML, which
  // parseTimedText accepts alongside VTT and SRT.
  let body: string;
  try {
    const response = await withTimeout(
      fetchImpl(track.baseUrl, { headers: { "user-agent": ANDROID_USER_AGENT } }),
      timeoutMs,
    );
    if (!response.ok) {
      return {
        ok: false,
        error: `YouTube returned ${response.status} for this video's captions.`,
        ...refused(response.status),
      };
    }
    body = await response.text();
  } catch (cause) {
    return { ok: false, error: networkFailure(cause) };
  }

  // A consent wall or an HTML error page is not an empty transcript.
  if (/^\s*<(!doctype|html)/i.test(body)) {
    return { ok: false, error: "YouTube served a consent or error page instead of a transcript." };
  }
  const cues = parseTimedText(body);
  if (cues.length === 0) {
    return { ok: false, error: "This video has no captions available." };
  }

  return {
    ok: true,
    videoId,
    canonicalUrl,
    title: typeof player.videoDetails?.title === "string" ? player.videoDetails.title : null,
    cues,
    text: cues.map((c) => c.text).join("\n"),
    language: typeof track.languageCode === "string" ? track.languageCode : language,
    generated: track.kind === "asr",
  };
}

/** A 4xx that is about this server rather than the video: not-found is the video's own answer. */
function refused(status: number): { blocked?: true } {
  return status >= 400 && status < 500 && status !== 404 ? { blocked: true } : {};
}

/** The "Sign in to confirm you're not a bot" wall (and its login-required cousins). */
function isBotCheck(playability: { status?: string; reason?: string }): boolean {
  return playability.status === "LOGIN_REQUIRED" || /not a bot|sign in to confirm/i.test(playability.reason ?? "");
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
