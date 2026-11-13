import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { enqueueOutbox, type OutboxHandler } from "@/domains/audit/outbox";
import { recordAudit } from "@/domains/audit/record";
import type { AuthContext } from "@/domains/identity/resolve";
import { notebooks } from "@/domains/knowledge/schema";
import { assertPublicUrl } from "@/domains/knowledge/web-fetch";
import { scrapeToMarkdown } from "@/integrations/firecrawl/client";
import { GenerationUnconfiguredError, type GenerationProvider } from "@/integrations/generation/provider";
import { resolveGeneration } from "@/domains/billing/resolver";
import { QuotaExhaustedError, drizzleQuotaStore, withQuota } from "@/integrations/providers/quota";
import { providerEntry } from "@/integrations/providers/registry";
import { db } from "@/lib/db";
import { withTransaction, type TxDrizzle } from "@/lib/db-transaction";
import { untrustedDataClauseJsonSafe } from "@/lib/prompts";
import { z } from "zod";
import { ConflictError, NotFoundError } from "./commands";
import { type CaptureEnrichment, enrichDispatchKey, readEnrichment } from "./enrich-state";
import { classifyFetchOutcome } from "./fetch-outcome";
import { captures } from "./schema";

/*
 * Opt-in Enrich for a link capture. Nothing here runs on capture: the person
 * clicks Enrich, requestCaptureEnrich queues one `capture.enrich_requested`
 * outbox row and marks the capture pending, and the outbox worker runs
 * enrichCapture, which scrapes the page once (Firecrawl), asks the generation
 * provider for a summary, 3-7 key points and a notebook from the workspace's
 * own list, and stores the result at raw_payload.enrichment. The rest of
 * raw_payload, the original, is never touched.
 *
 * A run only proceeds while the stored state is "pending", so an event with
 * no request behind it (or a redelivery after the run settled) does nothing.
 * Every failure is stored as `enrichment.error` with no summary and the event
 * completes: the person decides whether to retry, which is a new request under
 * a new dispatch key (enrich-state.ts).
 */

export const CAPTURE_ENRICH_TOPIC = "capture.enrich_requested";

/** Enough of a long article to summarize, without paying for all of it. */
const MAX_PAGE_CHARS = 24_000;
const MAX_KEY_POINTS = 7;
const MIN_KEY_POINTS = 3;
const MAX_TOKENS = 900;
/** The model chooses among the notebooks touched most recently. */
const NOTEBOOK_CHOICES = 50;

/** How long a request may stay pending before a new click replaces it. */
export const STALE_PENDING_MS = 10 * 60_000;

function isStalePending(requestedAt: string): boolean {
  const at = Date.parse(requestedAt);
  return Number.isNaN(at) || Date.now() - at > STALE_PENDING_MS;
}

export type CaptureEnrichResult =
  | { status: "enriched"; summary: string; keyPoints: string[]; suggestedNotebookId: string | null }
  | { status: "failed"; error: string }
  /** No request is pending: never asked, already settled, or the capture is gone. */
  | { status: "nothing-pending" };

export type CaptureEnrichDeps = {
  scrape?: typeof scrapeToMarkdown;
  provider?: GenerationProvider;
};

/**
 * The Enrich click. Only the capture's author or a workspace owner may ask, as
 * for a page re-read. A second click while a request is pending (and not stale),
 * or after a summary landed, enqueues nothing.
 */
export async function requestCaptureEnrich(
  auth: AuthContext,
  input: { captureId: string },
): Promise<{ enqueued: boolean }> {
  return withTransaction(async (tx) => {
    const [capture] = await tx
      .select({ id: captures.id, url: captures.url, createdBy: captures.createdBy, rawPayload: captures.rawPayload })
      .from(captures)
      .where(and(eq(captures.workspaceId, auth.workspaceId), eq(captures.id, input.captureId)))
      .limit(1);
    if (!capture || (capture.createdBy !== auth.userId && auth.role !== "owner")) {
      throw new NotFoundError("That capture no longer exists. Reload the inbox.");
    }
    if (!capture.url) throw new ConflictError("This capture has no link to read.");

    const current = readEnrichment(capture.rawPayload);
    if (current?.status === "done") return { enqueued: false };
    // A pending request that never settled (its event dead-lettered) would
    // block every click under the same key. Past the threshold it counts as a
    // failed run, so the retry gets a new key; the old run, if it ever
    // finishes, is fenced out by requestedAt.
    const stale = current?.status === "pending" && isStalePending(current.requestedAt);
    const failures = (current?.failures ?? 0) + (stale ? 1 : 0);
    const event = await enqueueOutbox(tx, auth, {
      topic: CAPTURE_ENRICH_TOPIC,
      payload: { captureId: capture.id },
      dispatchKey: enrichDispatchKey(capture.id, failures),
    });
    if (!event.enqueued) return { enqueued: false };

    await writeEnrichment(tx, auth.workspaceId, capture.id, {
      status: "pending",
      requestedAt: new Date().toISOString(),
      failures,
    });
    await recordAudit(
      auth,
      {
        action: "capture.enrich_requested",
        subjectType: "capture",
        subjectId: capture.id,
        summary: "Link summary requested",
      },
      tx,
    );
    return { enqueued: true };
  });
}

/** The capture's stored enrichment, for the detail pane's status poll. Null when not found or never requested. */
export async function readCaptureEnrichment(auth: AuthContext, captureId: string): Promise<CaptureEnrichment | null> {
  const [row] = await db
    .select({ rawPayload: captures.rawPayload })
    .from(captures)
    .where(and(eq(captures.workspaceId, auth.workspaceId), eq(captures.id, captureId)))
    .limit(1);
  return row ? readEnrichment(row.rawPayload) : null;
}

/** The outbox consumer: runs the pending request as the workspace's owner. */
export function captureEnrichRequestedHandler(
  resolveAuth: (workspaceId: string) => Promise<AuthContext | null>,
): OutboxHandler {
  return async (event) => {
    const payload = event.payload as { captureId?: unknown } | null;
    const captureId = typeof payload?.captureId === "string" ? payload.captureId : null;
    if (!captureId) throw new Error(`${CAPTURE_ENRICH_TOPIC} is missing captureId; redeploy the producer`);
    const auth = await resolveAuth(event.workspaceId);
    if (!auth) throw new Error("workspace has no active owner to act for the enrichment");
    await enrichCapture(auth, captureId);
  };
}

/** Fetch the page, write the summary, and store the outcome. Runs only for a pending request. */
export async function enrichCapture(
  auth: AuthContext,
  captureId: string,
  deps: CaptureEnrichDeps = {},
): Promise<CaptureEnrichResult> {
  const [capture] = await db
    .select({ url: captures.url, rawPayload: captures.rawPayload })
    .from(captures)
    .where(and(eq(captures.workspaceId, auth.workspaceId), eq(captures.id, captureId)))
    .limit(1);
  const request = capture ? readEnrichment(capture.rawPayload) : null;
  if (!capture?.url || request?.status !== "pending") return { status: "nothing-pending" };

  // Every settled write is fenced on this request's requestedAt, so a stale
  // run (a redelivered event whose lease expired) cannot overwrite a newer one.
  const settle = (next: CaptureEnrichment) =>
    writeEnrichment(db, auth.workspaceId, captureId, next, request.requestedAt);
  const fail = async (error: string): Promise<CaptureEnrichResult> => {
    await settle({ status: "failed", error, failedAt: new Date().toISOString(), failures: request.failures + 1 });
    return { status: "failed", error };
  };

  const page = await readPage(capture.url, deps.scrape ?? scrapeToMarkdown);
  if (!page.ok) return fail(page.error);

  let provider: GenerationProvider;
  try {
    provider = deps.provider ?? (await resolveGeneration(auth.workspaceId, "generation"));
  } catch (cause) {
    if (cause instanceof GenerationUnconfiguredError) {
      return fail("Summaries are not set up yet: no model is configured for this workspace.");
    }
    throw cause;
  }

  const choices = await db
    .select({ id: notebooks.id, title: notebooks.title })
    .from(notebooks)
    .where(and(eq(notebooks.workspaceId, auth.workspaceId), isNull(notebooks.archivedAt)))
    .orderBy(desc(notebooks.updatedAt), notebooks.id)
    .limit(NOTEBOOK_CHOICES);

  const written = await writeSummary(auth, provider, page.text, choices);
  if (!written.ok) return fail(written.error);

  const notebook = choices.find((choice) => choice.id === written.notebookId) ?? null;
  await settle({
    status: "done",
    summary: written.summary,
    keyPoints: written.keyPoints,
    suggestedNotebookId: notebook?.id ?? null,
    suggestedNotebookTitle: notebook?.title ?? null,
    enrichedAt: new Date().toISOString(),
    failures: request.failures,
  });
  return {
    status: "enriched",
    summary: written.summary,
    keyPoints: written.keyPoints,
    suggestedNotebookId: notebook?.id ?? null,
  };
}

async function readPage(
  url: string,
  scrape: typeof scrapeToMarkdown,
): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
  // A person pasted the link, but a pasted internal address must still never
  // become a server-side fetch target (same rule as the page re-read).
  const target = assertPublicUrl(url);
  if (!target) return { ok: false, error: "That link is not a public web page, so it cannot be read." };
  let page: Awaited<ReturnType<typeof scrapeToMarkdown>>;
  try {
    page = await scrape(target.toString());
  } catch {
    return { ok: false, error: "The page could not be reached. Try again in a minute." };
  }
  const { outcome, text } = classifyFetchOutcome(page);
  if (outcome === "acquired" && text) return { ok: true, text };
  if (outcome === "empty") return { ok: false, error: "The page has no readable text to summarize." };
  return { ok: false, error: "The site answered with an error page, so there is nothing to summarize." };
}

const reply = z.object({
  summary: z.string().trim().min(1).max(1_500),
  keyPoints: z.array(z.string().trim().min(1).max(400)),
  notebookId: z.string().nullable().optional(),
});

async function writeSummary(
  auth: AuthContext,
  provider: GenerationProvider,
  pageText: string,
  choices: Array<{ id: string; title: string }>,
): Promise<
  { ok: true; summary: string; keyPoints: string[]; notebookId: string | null } | { ok: false; error: string }
> {
  const fencedPage = untrusted("page", pageText.slice(0, MAX_PAGE_CHARS));
  const notebookList = choices.length
    ? choices.map((choice) => `- ${choice.id}: ${choice.title}`).join("\n")
    : "(none)";
  const prompt = `Notebooks (id: title):\n${untrusted("notebooks", notebookList)}\n\nThe saved page:\n${fencedPage}`;
  const call = () => provider.generate({ system: SYSTEM, prompt, json: true, temperature: 0.2, maxTokens: MAX_TOKENS });

  const entry = providerEntry(provider.registryId);
  const byTokens = entry?.quota?.unit === "tokens";
  const estimate = byTokens ? Math.ceil((SYSTEM.length + prompt.length) / 4) + MAX_TOKENS : 1;
  let text: string;
  try {
    const out =
      entry?.enabled && entry.quota
        ? await withQuota(drizzleQuotaStore(), entry, auth.workspaceId, estimate, call, (result) =>
            byTokens
              ? (result.usage?.inputTokens ?? estimate - MAX_TOKENS) + (result.usage?.outputTokens ?? MAX_TOKENS)
              : 1,
          )
        : await call();
    text = out.text;
  } catch (cause) {
    if (cause instanceof QuotaExhaustedError) {
      return { ok: false, error: "This month's allowance for summaries is used up. Retry after it renews." };
    }
    console.warn("capture enrich: the summary request failed:", cause instanceof Error ? cause.message : cause);
    return { ok: false, error: "The summary could not be written just now. Try again in a minute." };
  }

  let parsed: z.infer<typeof reply>;
  try {
    parsed = reply.parse(JSON.parse(text));
  } catch {
    return { ok: false, error: "The summary came back unreadable. Retry to ask again." };
  }
  if (parsed.keyPoints.length < MIN_KEY_POINTS) {
    return { ok: false, error: "The summary came back with too few key points. Retry to ask again." };
  }
  return {
    ok: true,
    summary: parsed.summary,
    keyPoints: parsed.keyPoints.slice(0, MAX_KEY_POINTS),
    notebookId: parsed.notebookId ?? null,
  };
}

const SYSTEM = `You summarize a web page a person saved to their inbox. Return JSON with exactly these keys: {"summary": string, "keyPoints": string[], "notebookId": string|null}.
"summary": two or three plain sentences on what the page says.
"keyPoints": ${MIN_KEY_POINTS} to ${MAX_KEY_POINTS} short points, one idea each, every one stated by the page itself.
"notebookId": the id of the one listed notebook this page clearly belongs in, or null when none clearly fits.
Never add facts the page does not state. Write in the page's language.
The notebooks and the page arrive between markers of the form <<label-xxxxxxxx>> and <</label-xxxxxxxx>>. ${untrustedDataClauseJsonSafe("text between the markers")}`;

/**
 * Wrap untrusted text in delimiters with a per-request random nonce, and
 * remove any copy of those delimiters from the text, so the text cannot close
 * its own block and speak outside it.
 */
function untrusted(label: string, text: string): string {
  const nonce = crypto.randomUUID().slice(0, 8);
  const open = `<<${label}-${nonce}>>`;
  const close = `<</${label}-${nonce}>>`;
  const body = text.replaceAll(open, "").replaceAll(close, "");
  return `${open}\n${body}\n${close}`;
}

/**
 * Set raw_payload.enrichment and nothing else; the original beside it stays as
 * it arrived. With `whilePendingSince`, the write lands only if that request
 * is still the pending one.
 */
async function writeEnrichment(
  executor: TxDrizzle | typeof db,
  workspaceId: string,
  captureId: string,
  next: CaptureEnrichment,
  whilePendingSince?: string,
): Promise<void> {
  await executor
    .update(captures)
    .set({ rawPayload: sql`jsonb_set(${captures.rawPayload}, '{enrichment}', ${JSON.stringify(next)}::jsonb)` })
    .where(
      and(
        eq(captures.workspaceId, workspaceId),
        eq(captures.id, captureId),
        whilePendingSince === undefined
          ? undefined
          : sql`${captures.rawPayload}->'enrichment'->>'requestedAt' = ${whilePendingSince}`,
      ),
    );
}
