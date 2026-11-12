/*
 * Which parts of a source explain something. A quiz question needs a
 * sentence that says how or why; a saved page also carries link indexes,
 * tables of contents, navigation rows and site notices, and a question cut
 * from those tests nothing ("Which server is listed third?").
 *
 * A source is read as blocks: runs of lines between blank lines, split
 * again where a list starts or stops, with a fenced code block kept whole.
 * Each block gets one kind. Only `links`, `outline` and `notice` blocks are
 * refused; prose, code and headings are kept, so a source with none of the
 * refused kinds reads exactly as it was saved.
 */

type BlockKind =
  | "prose"
  | "code"
  | "heading"
  /** A list or row whose entries are links with at most a short gloss. */
  | "links"
  /** A list of bare labels: a table of contents without its links. */
  | "outline"
  /** A site notice: where the docs index lives, cookie and copyright lines. */
  | "notice";

export type TextBlock = { start: number; end: number; kind: BlockKind };
type Span = { start: number; end: number };

/** A source with less explanation than this (about two sentences), and more index than explanation, is skipped. */
const MIN_EXPLANATORY_CHARS = 280;
/** A link entry may gloss its link in this many words and still be an index entry. */
const MAX_GLOSS_WORDS = 14;
/** A list item this short, with no sentence in it, is a label. */
const MAX_LABEL_WORDS = 6;
const MIN_OUTLINE_ITEMS = 4;
const MAX_NOTICE_CHARS = 400;

const FENCE = /^\s*(```|~~~)/;
const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s+/;
const HEADING = /^\s*#{1,6}\s+\S/;
const LINK = /!?\[([^\]\n]*)\]\([^)\n]*\)/g;
const BARE_URL = /<?https?:\/\/[^\s>)]+>?/g;
const NOTICE =
  /llms\.txt|skip to (?:main )?content|all rights reserved|cookie (?:policy|settings|preferences)|subscribe to (?:our|the) newsletter|was this page helpful|edit this page|on this page|table of contents/i;

const words = (text: string) => text.split(/\s+/).filter(Boolean).length;
const isRefused = (kind: BlockKind) => kind === "links" || kind === "outline" || kind === "notice";

/** Emphasis, quote and heading marks off, so what is left is what a reader sees around the links. */
function unmarked(line: string): string {
  return line
    .replace(/^(?:\s*>)+\s?/, "")
    .replace(LIST_ITEM, "")
    .replace(/[*_`~]+/g, "")
    .trim();
}

/** A line that leads with a link and adds at most a short gloss, or is mostly link text. */
function isLinkEntry(line: string): boolean {
  const text = unmarked(line);
  let linkChars = 0;
  const outside = text
    .replace(LINK, (_, label: string) => {
      linkChars += label.length;
      return "";
    })
    .replace(BARE_URL, (url) => {
      linkChars += url.length;
      return "";
    })
    .replace(/^[\s\-–—:|·•]+/, "");
  if (linkChars === 0) return false;
  const leadsWithLink = /^(?:!?\[[^\]\n]*\]\(|<?https?:\/\/)/.test(text);
  if (leadsWithLink) return words(outside) <= MAX_GLOSS_WORDS;
  const visible = linkChars + outside.replace(/\s+/g, "").length;
  return linkChars * 2 >= visible;
}

function isLabel(line: string): boolean {
  const text = unmarked(line);
  return words(text) <= MAX_LABEL_WORDS && !/[.!?。！？]["'”’)\]]?$/.test(text);
}

function kindOf(lines: string[]): BlockKind {
  if (FENCE.test(lines[0])) return "code";
  const text = lines.join("\n");
  if (text.length <= MAX_NOTICE_CHARS && NOTICE.test(text)) return "notice";
  if (lines.length === 1 && HEADING.test(lines[0])) return "heading";
  if (LIST_ITEM.test(lines[0])) {
    const items = lines.filter((line) => LIST_ITEM.test(line));
    if (items.filter(isLinkEntry).length * 5 >= items.length * 3) return "links";
    if (items.length >= MIN_OUTLINE_ITEMS && items.every(isLabel)) return "outline";
    return "prose";
  }
  return lines.every(isLinkEntry) ? "links" : "prose";
}

/** The source as blocks, in order. Offsets index `text`; blank lines belong to no block. */
export function textBlocks(text: string): TextBlock[] {
  const blocks: TextBlock[] = [];
  let open: { start: number; end: number; lines: string[]; list: boolean } | null = null;
  let fence: string | null = null;
  const close = () => {
    if (open) blocks.push({ start: open.start, end: open.end, kind: kindOf(open.lines) });
    open = null;
  };

  let offset = 0;
  for (const line of text.split("\n")) {
    const start = offset;
    const end = offset + line.length;
    offset = end + 1;
    const marker = FENCE.exec(line)?.[1] ?? null;
    if (fence) {
      open!.lines.push(line);
      open!.end = end;
      if (marker === fence) {
        fence = null;
        close();
      }
      continue;
    }
    if (line.trim() === "") {
      close();
      continue;
    }
    if (marker) {
      close();
      fence = marker;
      open = { start, end, lines: [line], list: false };
      continue;
    }
    const item = LIST_ITEM.test(line);
    // An indented line under a list item continues that item.
    const continuesList = open?.list && (item || /^\s+\S/.test(line));
    const startsBlock =
      !open || HEADING.test(line) || HEADING.test(open.lines[0]) || (open.list ? !continuesList : item);
    if (startsBlock) {
      close();
      open = { start, end, lines: [line], list: item };
    } else {
      open!.lines.push(line);
      open!.end = end;
    }
  }
  close();
  return blocks;
}

/**
 * True when what the span covers is mostly explanation. Headings and the
 * gaps between blocks are not counted either way, so a heading above a link
 * list cannot make the list read as prose. `blocks` is the source's
 * `textBlocks`.
 */
export function isExplanatorySpan(blocks: TextBlock[], span: Span): boolean {
  let kept = 0;
  let refused = 0;
  for (const block of blocks) {
    const overlap = Math.min(block.end, span.end) - Math.max(block.start, span.start);
    if (overlap <= 0 || block.kind === "heading") continue;
    if (isRefused(block.kind)) refused += overlap;
    else kept += overlap;
  }
  return kept > 0 && kept >= refused;
}

/** How far the text around `span` runs before a refused block: the room a passage has to grow in. */
export function explanatoryReach(blocks: TextBlock[], span: Span, textLength: number): Span {
  let start = 0;
  let end = textLength;
  for (const block of blocks) {
    if (!isRefused(block.kind)) continue;
    if (block.end <= span.start) start = Math.max(start, block.end);
    else if (block.start >= span.end) end = Math.min(end, block.start);
  }
  return { start, end };
}

/**
 * The source with its refused blocks removed, for the model to read. Kept
 * blocks stay verbatim and in order, so a quote taken from the result is
 * still found in the source. Returns the text unchanged when nothing is
 * refused.
 */
export function explanatoryText(text: string): string {
  const blocks = textBlocks(text);
  if (!blocks.some((block) => isRefused(block.kind))) return text;
  return blocks
    .filter((block) => !isRefused(block.kind))
    .map((block) => text.slice(block.start, block.end))
    .join("\n\n");
}

/**
 * True when the source is an index: more of it is links, outline and notices
 * than explanation, and what explanation it has could not carry a question.
 * A short source that is plain prose is not an index.
 */
export function isLinkIndex(text: string): boolean {
  let prose = 0;
  let refused = 0;
  for (const block of textBlocks(text)) {
    const length = block.end - block.start;
    if (block.kind === "prose") prose += length;
    else if (isRefused(block.kind)) refused += length;
  }
  return prose < MIN_EXPLANATORY_CHARS && refused > prose;
}
