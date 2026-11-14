import { afterEach, describe, expect, it, vi } from "vitest";
import type { Log } from "@sentry/nextjs";

/*
 * Sentry Logs: what reaches the Logs view, and what never does. With no DSN
 * the logger has no client and sends nothing; these tests check the calls
 * and the scrubbing, not the transport.
 */
const logger = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }));
vi.mock("@sentry/nextjs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@sentry/nextjs")>()),
  logger,
}));

const { scrubLog, sentryOptions } = await import("@/lib/sentry");
const { fetchTranscript } = await import("@/integrations/youtube/transcript");
const { scrapeToMarkdown } = await import("@/integrations/firecrawl/client");

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("scrubLog", () => {
  const log = (message: string, attributes?: Log["attributes"]): Log => ({ level: "warn", message, attributes });

  it("is the beforeSendLog hook for every runtime", () => {
    expect(sentryOptions("https://public@o0.ingest.sentry.io/0").beforeSendLog).toBe(scrubLog);
  });

  it("strips emails, bearer tokens, keys and URL paths from the message", () => {
    const out = scrubLog(
      log(
        "failed for ada@example.com with Bearer abc.def-123 key sk_live_1234567890abcdef at https://api.example.com/v1/workspaces/9f8e/notes?x=1",
      ),
    );
    expect(out.message).toBe("failed for [email] with Bearer [redacted] key [key] at https://api.example.com/…");
  });

  it("drops attributes that can hold content or secrets, and scrubs the rest", () => {
    const out = scrubLog(
      log("x", {
        kind: "flashcards",
        status: 500,
        email: "ada@example.com",
        prompt: "my notes",
        page: "https://a.b/c/d",
      }),
    );
    expect(out.attributes).toEqual({ kind: "flashcards", status: 500, page: "https://a.b/…" });
  });

  it("caps a long message", () => {
    expect(String(scrubLog(log("a".repeat(2_000))).message)).toHaveLength(500);
  });
});

describe("structured logs at failure points", () => {
  it("logs a YouTube bot-check refusal without the URL", async () => {
    const refused = { ok: false, status: 429, text: async () => "" };
    const out = await fetchTranscript("https://youtu.be/dQw4w9WgXcQ", { fetchImpl: async () => refused });
    expect(out).toMatchObject({ ok: false, blocked: true });
    expect(logger.warn).toHaveBeenCalledWith("youtube transcript blocked", { reason: "refused_server" });
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain("dQw4w9WgXcQ");
  });

  it("logs a video without captions as info, not a warning", async () => {
    await fetchTranscript("not a youtube url");
    expect(logger.info).toHaveBeenCalledWith("youtube transcript unavailable", { reason: "no_transcript" });
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("logs a Firecrawl failure with the operation and status only", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("down", { status: 502 })),
    );
    await expect(
      scrapeToMarkdown("https://private.example.com/doc/123", { FIRECRAWL_API_URL: "http://firecrawl:3002" }),
    ).rejects.toThrow("Firecrawl scrape returned 502");
    expect(logger.warn).toHaveBeenCalledWith("firecrawl request failed", { operation: "scrape", status: 502 });
  });
});
