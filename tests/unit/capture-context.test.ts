import { describe, expect, it } from "vitest";
import {
  captureContextSchema,
  hasCaptureContext,
  parseCaptureContextLenient,
  readCaptureContext,
} from "@/domains/capture/context";

describe("capture context", () => {
  it("accepts an empty context: nothing is required", () => {
    expect(captureContextSchema.safeParse({}).success).toBe(true);
    expect(hasCaptureContext({})).toBe(false);
  });

  it("accepts 'I don't know yet' as a complete answer to why it matters", () => {
    expect(captureContextSchema.parse({ why: { kind: "unknown" } })).toEqual({ why: { kind: "unknown" } });
  });

  it("rejects an empty answer and unknown fields", () => {
    expect(captureContextSchema.safeParse({ why: { kind: "answer", text: " ", via: "text" } }).success).toBe(false);
    expect(captureContextSchema.safeParse({ folder: "inbox" }).success).toBe(false);
  });

  it("keeps the fields that validate and names the ones it drops", () => {
    const { context, dropped } = parseCaptureContextLenient({
      passage: "kept",
      source: { url: "file:///tmp/a.pdf", title: "" },
      newerField: 1,
      why: { kind: "answer", text: "x".repeat(5_000), via: "voice" },
    });
    expect(context).toEqual({ passage: "kept" });
    expect(dropped.sort()).toEqual(["newerField", "source", "why"]);
  });

  it("treats blank strings as not sent rather than invalid", () => {
    expect(parseCaptureContextLenient({ source: { title: " ", url: "https://example.com/a" } })).toEqual({
      context: { source: { url: "https://example.com/a" } },
      dropped: [],
    });
    expect(parseCaptureContextLenient({ passage: "" })).toEqual({ context: undefined, dropped: [] });
  });

  it("reads back what is still valid from a stored context", () => {
    expect(readCaptureContext({ context: { passage: "p", retired: true } })).toEqual({ passage: "p" });
  });

  it("reads nothing from rows written before context existed", () => {
    expect(readCaptureContext({ text: "old row" })).toBeNull();
    expect(readCaptureContext(null)).toBeNull();
  });
});
