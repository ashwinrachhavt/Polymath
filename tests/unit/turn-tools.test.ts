import { describe, expect, it } from "vitest";
import {
  normalizeFetchUrl,
  normalizeSearchQuery,
  toolCallsThisTurn,
  type MessageLike,
} from "../../eve/polymath/agent/lib/turn-tools";

/*
 * The tool loop guards read the model's own turn history instead of keeping a
 * process-local cache, so these tests pin the two things they depend on: the
 * turn boundary is the last user message, and a result is joined to its call
 * by id. If either drifts, a duplicate fetch becomes invisible and the agent
 * can loop again.
 */

function assistantCall(toolCallId: string, toolName: string, input: Record<string, unknown>): MessageLike {
  return { role: "assistant", content: [{ type: "tool-call", toolCallId, toolName, input }] };
}

function toolResult(toolCallId: string, toolName: string, value: unknown): MessageLike {
  return {
    role: "tool",
    content: [{ type: "tool-result", toolCallId, toolName, output: { type: "json", value } }],
  };
}

describe("toolCallsThisTurn", () => {
  it("returns only calls made after the most recent user message", () => {
    const messages: MessageLike[] = [
      { role: "user", content: "first question" },
      assistantCall("old", "web_fetch", { url: "https://example.com/old" }),
      toolResult("old", "web_fetch", { ok: true }),
      { role: "user", content: "second question" },
      assistantCall("new", "web_fetch", { url: "https://example.com/new" }),
      toolResult("new", "web_fetch", { ok: true, markdown: "# New" }),
    ];

    expect(toolCallsThisTurn(messages, "web_fetch")).toEqual([
      { input: { url: "https://example.com/new" }, output: { ok: true, markdown: "# New" }, failed: false },
    ]);
  });

  it("marks a result with ok false as failed and leaves a pending call without a result", () => {
    const messages: MessageLike[] = [
      { role: "user", content: "read this" },
      assistantCall("failed", "web_fetch", { url: "https://example.com/failed" }),
      toolResult("failed", "web_fetch", { ok: false, error: "no captions" }),
      assistantCall("pending", "web_fetch", { url: "https://example.com/pending" }),
    ];

    expect(toolCallsThisTurn(messages, "web_fetch")).toEqual([
      {
        input: { url: "https://example.com/failed" },
        output: { ok: false, error: "no captions" },
        failed: true,
      },
      { input: { url: "https://example.com/pending" }, output: undefined, failed: false },
    ]);
  });

  it("unwraps a JSON string result and keeps another tool's calls out", () => {
    const messages: MessageLike[] = [
      { role: "user", content: "search then read" },
      assistantCall("search", "web_search", { query: "youtube" }),
      toolResult("search", "web_search", { ok: true, results: [] }),
      assistantCall("fetch", "web_fetch", { url: "https://example.com" }),
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "fetch",
            toolName: "web_fetch",
            output: { type: "text", value: '{"ok":false,"error":"blocked"}' },
          },
        ],
      },
    ];

    expect(toolCallsThisTurn(messages, "web_fetch")).toEqual([
      { input: { url: "https://example.com" }, output: { ok: false, error: "blocked" }, failed: true },
    ]);
  });
});

describe("normalizeFetchUrl", () => {
  it("collapses every YouTube address shape to one video identity", () => {
    expect(normalizeFetchUrl("https://www.youtube.com/watch?v=cd1xrO2q9HU&si=tracking#t=10")).toBe(
      "https://www.youtube.com/watch?v=cd1xrO2q9HU",
    );
    expect(normalizeFetchUrl("https://youtu.be/cd1xrO2q9HU")).toBe("https://www.youtube.com/watch?v=cd1xrO2q9HU");
    expect(normalizeFetchUrl("https://youtube.com/shorts/cd1xrO2q9HU")).toBe(
      "https://www.youtube.com/watch?v=cd1xrO2q9HU",
    );
  });

  it("drops the fragment and ignores malformed input", () => {
    expect(normalizeFetchUrl("https://example.com/page#section")).toBe("https://example.com/page");
    expect(normalizeFetchUrl("not a url")).toBe("not a url");
    expect(normalizeFetchUrl(undefined)).toBe("");
  });
});

describe("normalizeSearchQuery", () => {
  it("ignores case and repeated whitespace", () => {
    expect(normalizeSearchQuery("  YouTube   Transcript ")).toBe("youtube transcript");
    expect(normalizeSearchQuery(undefined)).toBe("");
  });
});
