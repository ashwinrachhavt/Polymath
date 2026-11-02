/*
 * Quote locating for quiz evidence. The ASH-292 locateQuote discipline is
 * byte-exact, but real extraction text is markdown: wiki links, citation
 * refs, and image embeds interrupt prose the model quotes as a reader sees
 * it ("at [Berlin](https://...)" quoted as "at Berlin"). A byte-exact
 * indexOf drops questions that are honestly grounded - starving the feature
 * on formatting artifacts is a failure as real as a padded quiz.
 *
 * locateQuoteNormalized matches in a normalized view (markdown links and
 * images resolved to their visible label, citation markers dropped,
 * whitespace runs collapsed) and maps the match back to offsets in the
 * ORIGINAL string. The anti-hallucination guarantee is unchanged: a quote
 * either appears in the document modulo formatting, or it does not locate.
 * It tolerates formatting, never paraphrase.
 */

export type QuoteSpan = { start: number; end: number };

export function locateQuoteNormalized(text: string, quote: string): QuoteSpan | null {
  const needle = quote.trim();
  if (!needle) return null;
  const hay = normalizeWithMap(text);
  const probe = normalizeWithMap(needle);
  if (!probe.normalized) return null;
  const start = hay.normalized.indexOf(probe.normalized);
  if (start < 0) return null;
  const last = start + probe.normalized.length - 1;
  return { start: hay.map[start], end: hay.map[last] + 1 };
}

type NormalizedText = {
  normalized: string;
  /** map[i] is the ORIGINAL-string index of normalized char i. */
  map: number[];
};

function normalizeWithMap(text: string): NormalizedText {
  const { out, map: strippedMap } = stripMarkdownLinks(text);
  let normalized = "";
  const map: number[] = [];
  let pendingSpace = false;
  for (let i = 0; i < out.length; i++) {
    const ch = out[i];
    if (/\s/.test(ch)) {
      // One space per whitespace run, anchored to the run's first char.
      pendingSpace = normalized.length > 0;
      continue;
    }
    if (pendingSpace) {
      normalized += " ";
      map.push(strippedMap[i]);
      pendingSpace = false;
    }
    normalized += ch;
    map.push(strippedMap[i]);
  }
  return { normalized, map };
}

type MappedText = { out: string; /** map[i] is the original index of out[i]. */ map: number[] };

/*
 * Resolve markdown links and images to their visible label:
 * [label](dest) -> label, ![alt](dest) -> "" (a wiki image's alt is
 * renderer noise, not prose). Labels strip recursively (extractions nest
 * images inside link labels), and a citation-only label ([2], [\[2\]])
 * drops entirely - a citation marker is not prose the reader reads.
 * Destinations allow balanced parentheses (wiki titles like
 * ..._(disambiguation)). Anything that does not parse as markdown stays
 * literal, so prose containing brackets is never corrupted.
 */
function stripMarkdownLinks(text: string, base = 0): MappedText {
  let out = "";
  const map: number[] = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    // <br>, <br/>, <br /> - extractions keep hard line breaks as HTML; a
    // reader sees a line break (whitespace), not the tag.
    if (ch === "<") {
      const br = /^<br\s*\/?>/i.exec(text.slice(i, i + 7));
      if (br) {
        out += " ";
        map.push(base + i);
        i += br[0].length;
        continue;
      }
    }
    if (ch === "!" && text[i + 1] === "[") {
      const image = parseLink(text, i + 1);
      if (image) {
        i = image.after;
        continue;
      }
    }
    if (ch === "[") {
      const link = parseLink(text, i);
      if (link) {
        if (isCitationLabel(link.label)) {
          i = link.after;
          continue;
        }
        const inner = stripMarkdownLinks(link.label, base + i + 1);
        out += inner.out;
        map.push(...inner.map);
        i = link.after;
        continue;
      }
    }
    out += ch;
    map.push(base + i);
    i++;
  }
  return { out, map };
}

function isCitationLabel(label: string): boolean {
  return /^\[?\[?\d+\]?\]$/.test(label.replace(/\\/g, ""));
}

function parseLink(text: string, bracketStart: number): { label: string; after: number } | null {
  // Find the matching ] allowing nesting (an image inside a link label).
  let depth = 0;
  let bracketEnd = -1;
  for (let i = bracketStart; i < text.length; i++) {
    if (text[i] === "[") depth++;
    else if (text[i] === "]") {
      depth--;
      if (depth === 0) {
        bracketEnd = i;
        break;
      }
    }
  }
  if (bracketEnd < 0 || text[bracketEnd + 1] !== "(") return null;
  // Find the ) that balances the (, wiki titles included.
  let parenDepth = 0;
  for (let i = bracketEnd + 1; i < text.length; i++) {
    if (text[i] === "(") parenDepth++;
    else if (text[i] === ")") {
      parenDepth--;
      if (parenDepth === 0) {
        return { label: text.slice(bracketStart + 1, bracketEnd), after: i + 1 };
      }
    }
  }
  return null;
}
