import { describe, expect, it } from "vitest";
import { captureContextSchema, hasCaptureContext, readCaptureContext } from "@/domains/capture/context";

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

  it("reads nothing from rows written before context existed", () => {
    expect(readCaptureContext({ text: "old row" })).toBeNull();
    expect(readCaptureContext(null)).toBeNull();
  });
});
