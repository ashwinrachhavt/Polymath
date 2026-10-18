/*
 * HTML page to reading text for URL capture. Capture runs in the Node
 * runtime, where there is no DOM; a full parser dependency is overkill for
 * pulling a page's text. Elements that carry no reading content are dropped
 * with their contents, block-level tags become line breaks, headings keep
 * their level as markdown, and the standard entities are decoded. What
 * remains is collapsed to clean lines. It is not a sanitizer: the output is
 * stored as text and rendered as text, never as HTML.
 */

/** Elements whose entire subtree is not reading content. */
const DROP_PATTERN = /<(script|style|noscript|template|svg|head|title|iframe|object|canvas|select|form)\b[\s\S]*?<\/\1\s*>/gi;

/** Tags that start a new line. */
const BLOCK_PATTERN = /<\/?(?:p|div|br|hr|ul|ol|dl|dt|dd|table|thead|tbody|tfoot|tr|td|th|section|article|aside|header|footer|nav|main|figure|figcaption|blockquote|pre|fieldset|caption)\b[^>]*>/gi;

/** Tags dropped without a trace once content-bearing tags above are handled. */
const TAG_PATTERN = /<[^>]+>/g;

const HEADING_PATTERN = /<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1\s*>/gi;

const LIST_ITEM_PATTERN = /<li\b[^>]*>/gi;

function decodeEntities(text: string): string {
  return text
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&(amp|lt|gt|quot|apos|nbsp);/g, (_, name) => {
      switch (name) {
        case "amp": return "&";
        case "lt": return "<";
        case "gt": return ">";
        case "quot": return "\"";
        case "apos": return "'";
        default: return " ";
      }
    });
}

export type PageText = { title: string | null; text: string };

/** The page's <title>, decoded and trimmed, or null when it has none. */
export function htmlTitle(html: string): string | null {
  const match = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(html);
  if (!match) return null;
  const title = decodeEntities(match[1]).replace(/\s+/g, " ").trim();
  return title || null;
}

/** Reading text from an HTML document: markdown headings, dashed list items, blank line between blocks. */
export function htmlToText(html: string): string {
  let working = html.replace(/<!--[\s\S]*?-->/g, "");
  // Nested drop elements (a script inside a template) need more than one pass.
  for (let pass = 0; pass < 4; pass += 1) {
    const next = working.replace(DROP_PATTERN, "");
    if (next === working) break;
    working = next;
  }
  const text = working
    .replace(HEADING_PATTERN, (_, level, inner) => `\n\n${"#".repeat(Number(level))} ${inner}\n\n`)
    .replace(LIST_ITEM_PATTERN, "\n- ")
    .replace(BLOCK_PATTERN, "\n")
    .replace(TAG_PATTERN, "")
    .replace(/ /g, " ");
  return decodeEntities(text)
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function extractPageText(html: string): PageText {
  return { title: htmlTitle(html), text: htmlToText(html) };
}

/**
 * True when the fetched body is an HTML page. The content type decides when
 * the server sent one; the sniff covers the (common) missing or generic type.
 */
export function isHtmlDocument(contentType: string | null, bytes: Uint8Array): boolean {
  const type = contentType?.split(";")[0].trim().toLowerCase() ?? "";
  if (type === "text/html" || type === "application/xhtml+xml") return true;
  if (type && type !== "text/plain" && type !== "application/octet-stream" && type !== "binary/octet-stream") {
    return false;
  }
  const head = new TextDecoder("utf-8").decode(bytes.slice(0, 1024)).replace(/^﻿/, "").trimStart().slice(0, 15).toLowerCase();
  return head.startsWith("<!doctype html") || head.startsWith("<html");
}
