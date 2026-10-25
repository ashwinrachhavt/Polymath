import { describe, expect, it } from "vitest";
import { captureDetailHeading } from "@/app/(workspace)/command-center/inbox/inbox-list";

describe("capture detail heading", () => {
  it("shows a stored enrichment title", () => {
    expect(captureDetailHeading({ title: "MongoDB annual letter", text: "Body text" })).toBe("MongoDB annual letter");
  });

  it("regression: an unlabeled text capture has no heading — the list labels it with the body's first line and the detail must not repeat it", () => {
    const capture = { title: null, text: "Here is something that confuses me about X.\n\nSecond line." };
    expect(captureDetailHeading(capture)).toBeNull();
  });

  it("uses a file's filename as its heading", () => {
    expect(captureDetailHeading({ rawPayload: { filename: "notes.pdf" } })).toBe("notes.pdf");
  });

  it("a url-only capture heads with its URL", () => {
    expect(captureDetailHeading({ kind: "url", url: "https://example.com/a", text: null })).toBe("https://example.com/a");
  });

  it("a capture with both text and a URL heads with nothing — the body is the content, the URL renders below", () => {
    expect(captureDetailHeading({ kind: "url", url: "https://example.com/a", text: "Pasted excerpt" })).toBeNull();
  });

  it("an empty capture has no heading", () => {
    expect(captureDetailHeading({ title: " ", text: " " })).toBeNull();
  });
});
