import { z } from "zod";
import type { Transport } from "@/domains/integrations/transport";

/*
 * Gmail reads as pure functions over a `Transport`. No database, no policy:
 * the gateway decides who may call these and what to do with the result.
 *
 * Every endpoint is built here from `users/me`, so no model-supplied string can
 * choose the host or path. A Gmail id is the only caller input that reaches a
 * URL, and it is encoded as a path segment.
 */

const GMAIL_BASE = "https://gmail.googleapis.com/gmail/v1/users/me";
const MESSAGES_ENDPOINT = `${GMAIL_BASE}/messages`;
const THREADS_ENDPOINT = `${GMAIL_BASE}/threads`;
const MAX_RESULTS_HARD_CAP = 100;

export type GmailMessageSummary = {
  id: string;
  threadId: string;
  from: string | null;
  subject: string | null;
  date: string | null;
  snippet: string | null;
  /** Gmail's own receipt time (ms). Present only when the caller asked for it; the Date header is sender-controlled. */
  internalDateMs?: number;
};

export type GmailThreadMessage = GmailMessageSummary & { bodyText: string | null };

export type GmailReadFailure = { ok: false; code: string; message: string };

export type GmailSearchResult = { ok: true; messages: GmailMessageSummary[] } | GmailReadFailure;

export type GmailThreadResult = { ok: true; messages: GmailThreadMessage[] } | GmailReadFailure;

/*
 * Gmail omits `messages` entirely when a search has no hits, and omits `payload`
 * on messages fetched without a body format or on drafts. Both are valid
 * responses, so the schema marks them optional rather than failing the read.
 */
const headerSchema = z.object({ name: z.string(), value: z.string() });

type GmailBodyPart = {
  mimeType?: string;
  body?: { data?: string };
  parts?: GmailBodyPart[];
};

const bodyPartSchema: z.ZodType<GmailBodyPart> = z.lazy(() =>
  z.object({
    mimeType: z.string().optional(),
    body: z.object({ data: z.string().optional() }).optional(),
    parts: z.array(bodyPartSchema).optional(),
  }),
);

const payloadSchema = z.object({
  mimeType: z.string().optional(),
  headers: z.array(headerSchema).optional(),
  body: z.object({ data: z.string().optional() }).optional(),
  parts: z.array(bodyPartSchema).optional(),
});

const messageSchema = z.object({
  id: z.string(),
  threadId: z.string().optional(),
  snippet: z.string().optional(),
  internalDate: z.string().optional(),
  payload: payloadSchema.optional(),
});

const listResponseSchema = z.object({
  messages: z.array(z.object({ id: z.string(), threadId: z.string(), snippet: z.string().optional() })).optional(),
});

const messageResponseSchema = messageSchema;

const threadResponseSchema = z.object({ messages: z.array(messageSchema).optional() });

/*
 * A response that does not match the schema is a failure, not a partial success.
 * A null-filled summary would render as "a message with no sender" and the
 * gateway would hand that to a model as fact. A header missing from a
 * well-formed message is different: Gmail legitimately omits Subject, so that
 * becomes null, which is honest.
 */
function malformed(what: string): GmailReadFailure {
  return {
    ok: false,
    code: "malformed_response",
    message: `Gmail returned a ${what} response this app does not recognise.`,
  };
}

/** Header lookup is case-insensitive because Gmail's casing is not contractual. */
function header(headers: Array<{ name: string; value: string }> | undefined, name: string): string | null {
  const match = headers?.find((candidate) => candidate.name.toLowerCase() === name);
  if (!match) return null;
  const value = match.value.trim();
  return value === "" ? null : value;
}

function decodeBase64Url(data: string): string | null {
  try {
    return Buffer.from(data, "base64url").toString("utf8");
  } catch {
    // A body we cannot decode is reported as absent; guessing at the bytes
    // would put invented text in front of the reader.
    return null;
  }
}

function stripHtml(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function findPart(part: GmailBodyPart | undefined, mimeType: string): GmailBodyPart | null {
  if (!part) return null;
  if (part.mimeType === mimeType && part.body?.data) return part;
  for (const child of part.parts ?? []) {
    const match = findPart(child, mimeType);
    if (match) return match;
  }
  return null;
}

function bodyText(payload: z.infer<typeof payloadSchema> | undefined): string | null {
  if (!payload) return null;
  const plain = findPart(payload, "text/plain");
  if (plain?.body?.data) {
    const text = decodeBase64Url(plain.body.data);
    if (text !== null) return text;
  }
  const html = findPart(payload, "text/html");
  if (html?.body?.data) {
    const markup = decodeBase64Url(html.body.data);
    if (markup !== null) return stripHtml(markup);
  }
  return null;
}

function summarise(
  message: z.infer<typeof messageSchema>,
  fallback: { threadId?: string; snippet?: string },
  withInternalDate = false,
): GmailMessageSummary {
  const headers = message.payload?.headers;
  const internalDateMs = withInternalDate && message.internalDate ? Number(message.internalDate) : Number.NaN;
  return {
    ...(Number.isFinite(internalDateMs) ? { internalDateMs } : {}),
    id: message.id,
    threadId: message.threadId ?? fallback.threadId ?? "",
    from: header(headers, "from"),
    subject: header(headers, "subject"),
    date: header(headers, "date"),
    snippet: message.snippet ?? fallback.snippet ?? null,
  };
}

/*
 * Gmail does not promise an order on `messages.list`, so sort on the Date
 * header. An unparseable date sorts last rather than dropping the message.
 */
function newestFirst(messages: GmailMessageSummary[]): GmailMessageSummary[] {
  const at = (message: GmailMessageSummary) => {
    const parsed = message.date ? Date.parse(message.date) : Number.NaN;
    return Number.isNaN(parsed) ? Number.NEGATIVE_INFINITY : parsed;
  };
  return [...messages].sort((a, b) => at(b) - at(a));
}

function failureFrom(result: { code: string; message: string }): GmailReadFailure {
  return { ok: false, code: result.code, message: result.message };
}

/*
 * `messages.list` returns ids only, so search follows with one metadata read per
 * hit. Those run with bounded concurrency: serially, a 100-hit search is 100
 * round trips in series and reads as a hung tool; unbounded, it is a burst that
 * trips provider rate limits. Five in flight turns 100 calls into ~20 waves
 * without being a burst. Results are collected by index so the order is the
 * same whatever order the responses arrive in.
 */
const DETAIL_CONCURRENCY = 5;

export async function searchGmailMessages(
  transport: Transport,
  input: {
    connectedAccountId: string;
    query: string;
    limit: number;
    /** Also return Gmail's receipt time on each summary (needed to bound a window; the gateway does not ask). */
    includeInternalDate?: boolean;
    /** Carried for the gateway's dedupe and audit; this module never routes on it. */
    accountAlias?: string;
  },
): Promise<GmailSearchResult> {
  const limit = Math.max(1, Math.min(input.limit, MAX_RESULTS_HARD_CAP));

  const list = await transport.read({
    connectedAccountId: input.connectedAccountId,
    endpoint: MESSAGES_ENDPOINT,
    method: "GET",
    // No format/metadataHeaders: only ids, threadIds and snippets are read from
    // the list; headers and bodies come from the per-message detail read below.
    query: { q: input.query, maxResults: String(limit) },
  });
  if (!list.ok) return failureFrom(list);

  const parsed = listResponseSchema.safeParse(list.data);
  if (!parsed.success) return malformed("search");

  const hits = (parsed.data.messages ?? []).slice(0, limit);
  const summaries: Array<GmailMessageSummary | null> = new Array(hits.length).fill(null);
  // The first failure observed stops the remaining workers. A failure fails the
  // whole search: a partial answer would look like a complete one, and which
  // detail read failed first is not something the caller can act on anyway.
  let failure: GmailReadFailure | null = null;
  let next = 0;

  async function worker(): Promise<void> {
    while (failure === null) {
      const index = next++;
      if (index >= hits.length) return;
      const hit = hits[index];
      const detail = await transport.read({
        connectedAccountId: input.connectedAccountId,
        endpoint: `${MESSAGES_ENDPOINT}/${encodeURIComponent(hit.id)}`,
        method: "GET",
        // format=full, not metadata: Gmail takes metadataHeaders only as repeated
        // query params, and the proxy collapses repeats to the last value
        // (live-verified 2026-10-23). metadata without them returns zero headers,
        // which is how this read used to surface every message as "(no subject)".
        query: { format: "full" },
      });
      if (!detail.ok) {
        failure ??= failureFrom(detail);
        return;
      }
      const message = messageResponseSchema.safeParse(detail.data);
      if (!message.success) {
        failure ??= malformed("message");
        return;
      }
      summaries[index] = summarise(message.data, { threadId: hit.threadId, snippet: hit.snippet }, input.includeInternalDate);
    }
  }

  await Promise.all(Array.from({ length: Math.min(DETAIL_CONCURRENCY, hits.length) }, worker));
  if (failure !== null) return failure;

  // `null` can only survive if a worker stopped on a failure, which returned above.
  return { ok: true, messages: newestFirst(summaries.filter((summary) => summary !== null)) };
}

export async function readGmailThread(
  transport: Transport,
  input: { connectedAccountId: string; threadId: string },
): Promise<GmailThreadResult> {
  const response = await transport.read({
    connectedAccountId: input.connectedAccountId,
    endpoint: `${THREADS_ENDPOINT}/${encodeURIComponent(input.threadId)}`,
    method: "GET",
    query: { format: "full" },
  });
  if (!response.ok) return failureFrom(response);

  const parsed = threadResponseSchema.safeParse(response.data);
  if (!parsed.success) return malformed("thread");

  // Gmail returns thread messages oldest-first; that is the reading order, so it
  // is preserved rather than re-sorted.
  const messages = (parsed.data.messages ?? []).map((message) => ({
    ...summarise(message, { threadId: input.threadId }),
    bodyText: bodyText(message.payload),
  }));

  return { ok: true, messages };
}
