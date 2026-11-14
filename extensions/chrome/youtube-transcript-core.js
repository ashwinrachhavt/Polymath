/**
 * YouTube transcript reading — the pure half.
 *
 * The content script reads a transcript from the YouTube page the person has
 * open, in their own session (their cookies, their browser), and the popup
 * sends it with the capture so the server does not have to fetch one (YouTube
 * refuses some server hosts). This module owns every decision that can be
 * made without a page: which id, which caption track, how a track's body or
 * the transcript panel's rows become cues, and the size bounds the server also
 * enforces. content.js owns the fetching and the DOM. Plain script in the
 * browser, CommonJS in vitest, same split as outbox-core.js.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.PolymathYouTubeTranscript = api;
})(typeof self !== "undefined" ? self : globalThis, function () {
  "use strict";

  // The server's own ceilings (domains/knowledge/youtube-transcript-schema.ts).
  const MAX_CUES = 20000;
  const MAX_CUE_TEXT = 2000;
  const MAX_TRANSCRIPT_CHARS = 600000;

  const WATCH_HOSTS = ["youtube.com", "www.youtube.com", "m.youtube.com"];

  /** The video id of a watch or shorts address, or null for any other page. */
  function videoIdFromUrl(href) {
    let url;
    try {
      url = new URL(href);
    } catch (error) {
      return null;
    }
    if (!WATCH_HOSTS.includes(url.hostname.toLowerCase())) return null;
    const id = url.pathname === "/watch" ? url.searchParams.get("v") : (/^\/shorts\/([A-Za-z0-9_-]{11})/.exec(url.pathname) || [])[1];
    return id && /^[A-Za-z0-9_-]{11}$/.test(id) ? id : null;
  }

  /**
   * The player response object embedded in a watch page's HTML
   * (`ytInitialPlayerResponse = {...};`), or null. Reads the object by
   * matching braces, skipping strings, so a brace inside a title cannot end it
   * early.
   */
  function playerResponseFromHtml(html) {
    const marker = /ytInitialPlayerResponse\s*=\s*/.exec(html);
    if (!marker) return null;
    const start = html.indexOf("{", marker.index + marker[0].length - 1);
    if (start === -1) return null;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < html.length; i += 1) {
      const char = html[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === '"') inString = false;
        continue;
      }
      if (char === '"') inString = true;
      else if (char === "{") depth += 1;
      else if (char === "}") {
        depth -= 1;
        if (depth === 0) {
          try {
            return JSON.parse(html.slice(start, i + 1));
          } catch (error) {
            return null;
          }
        }
      }
    }
    return null;
  }

  /** The caption tracks a player response lists (each with a baseUrl), possibly none. */
  function captionTracksOf(player) {
    const tracks =
      player &&
      player.captions &&
      player.captions.playerCaptionsTracklistRenderer &&
      player.captions.playerCaptionsTracklistRenderer.captionTracks;
    return Array.isArray(tracks) ? tracks.filter((track) => track && typeof track.baseUrl === "string") : [];
  }

  /**
   * An authored track in the wanted language, then an auto-generated one in
   * it, then the first track the video offers. `kind: "asr"` marks
   * auto-generated.
   */
  function pickTrack(tracks, language) {
    if (tracks.length === 0) return null;
    const wanted = String(language || "en").toLowerCase().split("-")[0];
    const inLanguage = tracks.filter((track) => String(track.languageCode || "").toLowerCase().split("-")[0] === wanted);
    return inLanguage.find((track) => track.kind !== "asr") || inLanguage[0] || tracks[0];
  }

  /** The track's address asking for JSON, which parses without guessing a markup shape. */
  function json3Url(baseUrl) {
    const url = new URL(baseUrl, "https://www.youtube.com");
    url.searchParams.set("fmt", "json3");
    return url.href;
  }

  function cleanText(text) {
    return String(text || "")
      .replace(/\s+/g, " ")
      .trim();
  }

  /** Cues from a json3 timed-text body: events with a start, a duration and text segments. */
  function cuesFromJson3(body) {
    let data;
    try {
      data = typeof body === "string" ? JSON.parse(body) : body;
    } catch (error) {
      return [];
    }
    const events = data && Array.isArray(data.events) ? data.events : [];
    const cues = [];
    for (const event of events) {
      if (!event || !Array.isArray(event.segs) || typeof event.tStartMs !== "number") continue;
      const text = cleanText(event.segs.map((seg) => (seg && seg.utf8) || "").join(""));
      if (!text) continue;
      cues.push({
        start: round3(event.tStartMs / 1000),
        duration: round3((typeof event.dDurationMs === "number" ? event.dDurationMs : 0) / 1000),
        text,
      });
    }
    return cues;
  }

  /** "1:02:03", "12:34" or "0:07" as seconds, or null. */
  function secondsFromClock(text) {
    const parts = String(text || "")
      .trim()
      .split(":")
      .map((part) => Number(part));
    if (parts.length < 2 || parts.length > 3 || parts.some((part) => !Number.isInteger(part) || part < 0)) return null;
    return parts.reduce((total, part) => total * 60 + part, 0);
  }

  /**
   * Cues from the transcript panel's rows (`[{ time: "1:02", text }]`). A
   * row's duration runs to the next row's start; the last one gets zero.
   */
  function cuesFromPanelRows(rows) {
    const timed = [];
    for (const row of rows) {
      const start = secondsFromClock(row && row.time);
      const text = cleanText(row && row.text);
      if (start !== null && text) timed.push({ start, text });
    }
    return timed.map((row, index) => ({
      start: row.start,
      duration: index + 1 < timed.length ? Math.max(0, timed[index + 1].start - row.start) : 0,
      text: row.text,
    }));
  }

  function round3(n) {
    return Math.round(n * 1000) / 1000;
  }

  /**
   * The payload sent with a capture, bounded the way the server bounds it, or
   * null when there is nothing to send. Over-long input is cut at the ceiling
   * rather than refused: the start of a talk is better than none.
   */
  function buildTranscript(input) {
    const cues = [];
    let chars = 0;
    for (const cue of input.cues || []) {
      const text = cleanText(cue.text).slice(0, MAX_CUE_TEXT);
      if (!text || !Number.isFinite(cue.start) || cue.start < 0 || cue.start > 86400) continue;
      if (cues.length >= MAX_CUES || chars + text.length > MAX_TRANSCRIPT_CHARS) break;
      chars += text.length;
      cues.push({
        start: cue.start,
        duration: Number.isFinite(cue.duration) ? Math.min(Math.max(cue.duration, 0), 86400) : 0,
        text,
      });
    }
    if (cues.length === 0 || !/^[A-Za-z0-9_-]{11}$/.test(input.videoId || "")) return null;
    return {
      videoId: input.videoId,
      title: input.title ? String(input.title).slice(0, 500) : null,
      language: input.language ? String(input.language).slice(0, 20) : null,
      generated: Boolean(input.generated),
      cues,
    };
  }

  return {
    MAX_CUES,
    MAX_TRANSCRIPT_CHARS,
    videoIdFromUrl,
    playerResponseFromHtml,
    captionTracksOf,
    pickTrack,
    json3Url,
    cuesFromJson3,
    cuesFromPanelRows,
    buildTranscript,
  };
});
