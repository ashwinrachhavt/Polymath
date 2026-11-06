import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { FileCapturePanel } from "@/app/(workspace)/command-center/inbox/inbox-detail";

describe("Inbox file capture rendering", () => {
  it("shows images inside the capture and keeps the file link on the Inbox page", () => {
    const html = renderToStaticMarkup(
      createElement(FileCapturePanel, {
        captureId: "capture-1",
        rawPayload: { filename: "clipboard.png", mimeType: "image/png", sizeBytes: 512, textSource: "clipboard" },
        text: "Copied headline\n\nCopied paragraph.",
        processingState: "enriched",
        failureReason: null,
      }),
    );

    expect(html).toContain('<img src="/api/v1/captures/capture-1/file"');
    expect(html).toContain('alt="clipboard.png"');
    expect(html).toContain("Copied headline");
    expect(html).toContain("Copied paragraph.");
    expect(html).toContain('download="clipboard.png"');
    expect(html).not.toContain('target="_blank"');
  });

  it("continues to offer non-image files in a separate tab", () => {
    const html = renderToStaticMarkup(
      createElement(FileCapturePanel, {
        captureId: "capture-2",
        rawPayload: { filename: "notes.pdf", mimeType: "application/pdf", sizeBytes: 512 },
        text: null,
        processingState: "unprocessed",
        failureReason: null,
      }),
    );

    expect(html).not.toContain("<img");
    expect(html).toContain('target="_blank"');
  });
});
