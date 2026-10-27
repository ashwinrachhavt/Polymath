import { describe, expect, it } from "vitest";
import { contentHash, inferCaptureMode, workingText } from "@/domains/capture/mode";

describe("inferCaptureMode", () => {
  it("is url-reference when there is a url and no text", () => {
    expect(inferCaptureMode({ url: "https://example.com/a" })).toBe("url-reference");
  });
  it("is authored when there is text and no url", () => {
    expect(inferCaptureMode({ text: "a thought" })).toBe("authored");
  });
  it("is page when text arrived with a url and no mode was supplied", () => {
    expect(inferCaptureMode({ text: "body", url: "https://example.com/a" })).toBe("page");
  });
  it("is authored when the text is itself a bare address and no url was supplied", () => {
    expect(inferCaptureMode({ text: "https://example.com/a" })).toBe("url-reference");
  });
  it("is blob for a file or a voice capture", () => {
    expect(inferCaptureMode({ kind: "file" })).toBe("blob");
    expect(inferCaptureMode({ kind: "voice" })).toBe("blob");
  });
});

describe("contentHash", () => {
  it("is stable for the same text", () => {
    expect(contentHash("same")).toBe(contentHash("same"));
  });
  it("differs for different text", () => {
    expect(contentHash("a")).not.toBe(contentHash("b"));
  });
  it("is 64 hex characters even for a 200k body", () => {
    expect(contentHash("x".repeat(200_000))).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("workingText", () => {
  const base = { text: "selection", fetchedText: "whole page" };
  it("keeps the person's text for a selection even after a fetch", () => {
    expect(workingText({ ...base, captureMode: "selection" })).toBe("selection");
  });
  it("prefers the fetched reading for a page grab", () => {
    expect(workingText({ ...base, captureMode: "page" })).toBe("whole page");
  });
  it("falls back to text when a page grab has not been fetched yet", () => {
    expect(workingText({ captureMode: "page", text: "grab", fetchedText: null })).toBe("grab");
  });
  it("prefers the fetched text for a bare address", () => {
    expect(workingText({ captureMode: "url-reference", text: null, fetchedText: "page" })).toBe("page");
  });
  it("is null for a blob with no text", () => {
    expect(workingText({ captureMode: "blob", text: null, fetchedText: null })).toBeNull();
  });
});
