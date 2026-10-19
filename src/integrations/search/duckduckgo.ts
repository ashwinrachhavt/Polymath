import { WEB_SEARCH_TIMEOUT_MS, WebSearchError, type WebSearchProvider, type WebSearchResult } from "./provider";

/*
 * The zero-config provider: DuckDuckGo's public HTML endpoint needs no key and
 * bills nothing, so a workspace with no search env vars still gets a working
 * tool. It is unofficial and best-effort — the markup can change, and a
 * changed page yields fewer results rather than wrong ones, because every
 * result must parse a real href AND a title before it is kept.
 */

const ENDPOINT = "https://html.duckduckgo.com/html/";
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

function decodeEntities(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&#x2F;/g, "/");
}

function stripTags(html: string): string {
  return decodeEntities(html.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim());
}

/*
 * DDG wraps outbound links in /l/?uddg=<urlencoded>. Results without the
 * wrapper (rare, e.g. some instant answers) are skipped rather than emitted
 * with a dead redirect URL.
 */
function unwrapDuckDuckGoUrl(href: string): string | null {
  const match = /[?&]uddg=([^&]+)/.exec(href);
  if (!match) return null;
  try {
    const url = decodeURIComponent(match[1]);
    return url.startsWith("http://") || url.startsWith("https://") ? url : null;
  } catch {
    return null;
  }
}

/** Exported for the fixture test: pure HTML -> results, no network. */
export function parseDuckDuckGoHtml(html: string, limit: number): WebSearchResult[] {
  const results: WebSearchResult[] = [];
  const titleRe = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  const snippetRe = /<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/;
  let match: RegExpExecArray | null;
  while ((match = titleRe.exec(html)) !== null && results.length < limit) {
    const url = unwrapDuckDuckGoUrl(decodeEntities(match[1]));
    const title = stripTags(match[2]);
    if (!url || !title) continue;
    // The snippet sits between this title link and the next result's title;
    // bounding the search there keeps one result's snippet from bleeding into
    // the next (and an optional-group regex cannot express "match if present"
    // here, because a lazy skip is always a valid overall match).
    const rest = html.slice(titleRe.lastIndex);
    const nextTitle = rest.search(/<a[^>]+class="result__a"/);
    const window = nextTitle === -1 ? rest : rest.slice(0, nextTitle);
    const snippet = snippetRe.exec(window);
    results.push({ title, url, snippet: snippet ? stripTags(snippet[1]) : "", publishedAt: null });
  }
  return results;
}

export function duckDuckGoProvider(): WebSearchProvider {
  return {
    name: "duckduckgo",
    async search(query, limit) {
      const response = await fetch(`${ENDPOINT}?q=${encodeURIComponent(query)}`, {
        headers: { "user-agent": USER_AGENT },
        signal: AbortSignal.timeout(WEB_SEARCH_TIMEOUT_MS),
      });
      if (!response.ok) {
        throw new WebSearchError(`DuckDuckGo returned ${response.status}`, "duckduckgo");
      }
      return parseDuckDuckGoHtml(await response.text(), limit);
    },
  };
}
