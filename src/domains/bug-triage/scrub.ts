/*
 * Everything the bug agent writes to GitHub passes through here first. The
 * repository is public, so an issue body is a publication: no email, token,
 * IP address, id-bearing URL or captured text may survive.
 *
 * The scrubber is the second line. The first is that issues are built from an
 * allowlist of structured fields (error type, message, frames, route pattern,
 * counts) and never from a raw payload, so request bodies, headers, cookies,
 * breadcrumbs and user objects are not read at all.
 */

const MAX_MESSAGE_CHARS = 300;
/** Quoted strings longer than this are more likely user text than an identifier. */
const MAX_QUOTED_CHARS = 40;

const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
const IPV4 = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;
// Either the full eight-group form or a compressed form with `::`. Requiring
// five or more groups (or `::`) leaves `12:30:45` times and `file:12:5` alone.
const IPV6 =
  /(?<![\w:])(?:[0-9a-f]{1,4}:){4,7}[0-9a-f]{1,4}(?![\w:])|(?<![\w:])(?:[0-9a-f]{1,4}(?::[0-9a-f]{1,4}){0,5})?::(?:[0-9a-f]{1,4}(?::[0-9a-f]{1,4}){0,5})?(?![\w:])/gi;
const BEARER = /\b(Bearer|Basic|Token)\s+[\w\-.~+/=]{8,}/gi;
const JWT = /\beyJ[\w-]{5,}\.[\w-]{5,}\.[\w-]{5,}\b/g;
const PREFIXED_SECRET =
  /\b(?:sk|pk|rk|sk_live|sk_test|pk_live|pk_test|ghp|gho|ghu|ghs|ghr|github_pat|xox[abpr]|glpat|AKIA|ASIA)[_-][\w-]{8,}\b|\bAKIA[0-9A-Z]{16}\b/g;
const KEY_VALUE_SECRET =
  /\b(password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|auth|authorization|cookie|session)(["']?\s*[:=]\s*["']?)[^\s"',;&]+/gi;
/** Drizzle and postgres errors append the bound parameters: user data, always. */
const QUERY_PARAMS = /\bparams:.*$/gim;
const LONG_DIGITS = /\b\d{9,}\b/g;
// Hex or base62 runs long enough to be an id or a key rather than a word.
const OPAQUE_ID = /\b(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{20,}\b/g;
const CLERK_ID = /\b(?:user|org|sess|inv|client)_[A-Za-z0-9]{10,}\b/g;
const HTTP_URL = /\bhttps?:\/\/[^\s"'<>)\]]+/gi;
const QUOTED = new RegExp(`(["'\`])((?:(?!\\1).){${MAX_QUOTED_CHARS + 1},}?)\\1`, "g");
const HOME_DIR = /(?:\/Users|\/home)\/[^/\s]+/g;

/** Free text from an error: a message, a title, a culprit. */
export function scrubText(input: string): string {
  const scrubbed = input
    .replace(QUERY_PARAMS, "params: <redacted>")
    .replace(HTTP_URL, "<url>")
    .replace(BEARER, "$1 <token>")
    .replace(JWT, "<token>")
    .replace(PREFIXED_SECRET, "<token>")
    .replace(KEY_VALUE_SECRET, "$1$2<redacted>")
    .replace(EMAIL, "<email>")
    .replace(UUID, ":id")
    .replace(CLERK_ID, ":id")
    .replace(IPV4, "<ip>")
    .replace(IPV6, "<ip>")
    .replace(HOME_DIR, "~")
    .replace(OPAQUE_ID, ":id")
    .replace(LONG_DIGITS, ":id")
    .replace(QUOTED, (_match, quote: string) => `${quote}<text>${quote}`)
    .replace(/\s+/g, " ")
    .trim();
  return scrubbed.length > MAX_MESSAGE_CHARS ? `${scrubbed.slice(0, MAX_MESSAGE_CHARS - 1)}…` : scrubbed;
}

/**
 * An app path reduced to its route pattern: `/notes/3f1c…?q=x#h` becomes
 * `/notes/:id`. Any segment that looks like an id, or is not a plain slug,
 * becomes `:id`; a full URL loses its host, query and fragment.
 */
export function routePattern(input: string): string {
  let path = input.trim();
  try {
    path = new URL(path, "http://route.invalid").pathname;
  } catch {
    return "/";
  }
  const segments = path
    .split("/")
    .filter(Boolean)
    .slice(0, 8)
    .map((segment) => {
      let decoded: string;
      try {
        decoded = decodeURIComponent(segment);
      } catch {
        return ":id";
      }
      return isPlainSegment(decoded) ? decoded : ":id";
    });
  return `/${segments.join("/")}`;
}

function isPlainSegment(segment: string): boolean {
  // Slugs written by the app are lowercase words joined by dashes. Anything
  // with a digit, upper case, or punctuation is a record id or user text.
  return /^[a-z]+(?:-[a-z]+)*$/.test(segment) && segment.length <= 32;
}

/**
 * A stack frame's file, as a repo-relative `src/...` path when it is ours.
 * Bundler prefixes (`webpack-internal:///(rsc)/./`, `app:///`, `/app/`) are
 * dropped; a frame outside `src/` (node_modules, chunks, the runtime) is null.
 */
export function repoFile(frameFile: string | null | undefined): string | null {
  if (!frameFile || frameFile.includes("node_modules")) return null;
  const match = /(?:^|[/.(])(src\/[\w./@()[\]-]+\.(?:tsx?|jsx?|mjs))/.exec(frameFile);
  return match ? match[1].replace(/\/\.\//g, "/") : null;
}
