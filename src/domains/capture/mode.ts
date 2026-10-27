import { createHash } from "node:crypto";

export type CaptureMode = "authored" | "selection" | "page" | "url-reference" | "blob";

const BARE_ADDRESS = /^https?:\/\/\S+$/i;

export function contentHash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function inferCaptureMode(input: { text?: string; url?: string; kind?: string }): CaptureMode {
  if (input.kind === "file" || input.kind === "voice") return "blob";
  const text = input.text?.trim();
  if (!input.url && text && BARE_ADDRESS.test(text)) return "url-reference";
  if (input.url) return text ? "page" : "url-reference";
  return "authored";
}

export function workingText(capture: {
  captureMode: CaptureMode;
  text: string | null;
  fetchedText: string | null;
}): string | null {
  if (capture.captureMode === "page" || capture.captureMode === "url-reference") {
    return capture.fetchedText ?? capture.text;
  }
  return capture.text;
}
