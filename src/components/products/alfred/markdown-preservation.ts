export type MarkdownEditorMode = "rich" | "source";

/*
 * The rich editor is StarterKit: no tables, no images, no task lists, no raw
 * HTML. A document holding any of those round-trips lossily, so it opens in
 * source mode instead and rich editing stays disabled until the constructs are
 * rewritten.
 *
 * The HTML test names real elements rather than matching any `<...>` token.
 * Angle brackets are ordinary prose — an address in <angle brackets>, a
 * generic Array<string>, an autolink <https://example.com> — and treating each
 * of those as HTML blocked pasting perfectly ordinary text. `<foo>` that is not
 * an element is preserved as literal text by the markdown parser anyway.
 */
const HTML_ELEMENTS = new Set([
  "a", "abbr", "address", "area", "article", "aside", "audio", "b", "base",
  "bdi", "bdo", "blockquote", "body", "br", "button", "canvas", "caption",
  "cite", "code", "col", "colgroup", "data", "datalist", "dd", "del",
  "details", "dfn", "dialog", "div", "dl", "dt", "em", "embed", "fieldset",
  "figcaption", "figure", "footer", "form", "h1", "h2", "h3", "h4", "h5",
  "h6", "head", "header", "hgroup", "hr", "html", "i", "iframe", "img",
  "input", "ins", "kbd", "label", "legend", "li", "link", "main", "map",
  "mark", "menu", "meta", "meter", "nav", "noscript", "object", "ol",
  "optgroup", "option", "output", "p", "param", "picture", "pre", "progress",
  "q", "rp", "rt", "ruby", "s", "samp", "script", "search", "section",
  "select", "slot", "small", "source", "span", "strong", "style", "sub",
  "summary", "sup", "svg", "table", "tbody", "td", "template", "textarea",
  "tfoot", "th", "thead", "time", "tr", "track", "u", "ul", "var", "video",
  "wbr",
]);

/** A real tag: an HTML element name, or any tag carrying attributes. */
function hasRawHtml(content: string): boolean {
  if (/<!--[\s\S]*?-->/.test(content)) return true;
  for (const match of content.matchAll(/<\/?([a-zA-Z][\w-]*)((?:\s[^<>]*)?)\/?>/g)) {
    if (HTML_ELEMENTS.has(match[1].toLowerCase()) || match[2].trim()) return true;
  }
  return false;
}

export function markdownSourceReason(content: string): string | undefined {
  if (content.split(/\r?\n/).some((line) => line.includes("|") && /^\s*(?:>\s*)*[|:\-\s]+$/.test(line) && /-/.test(line))) return "tables";
  if (/!\[[\s\S]*?\](?:\s*\(|\s*\[)/.test(content)) return "images";
  if (/^\s*(?:>\s*)*(?:[-+*]|\d+[.)])\s+\[[ xX]\]/m.test(content)) return "task checkbox states";
  if (hasRawHtml(content)) return "raw HTML";
  if (/^\s*(?:>\s*)*\[[^\]\n]+\]:\s*\S/m.test(content) || /!?\[[^\]\n]*\]\s*\[[^\]\n]*\]/.test(content) || /\[\^[^\]\n]+\]/.test(content)) return "reference links, images or footnotes";
  return undefined;
}

export function markdownEditorMode(content: string, preferred: MarkdownEditorMode = "rich"): MarkdownEditorMode {
  return markdownSourceReason(content) ? "source" : preferred;
}
