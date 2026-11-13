import { createHash } from "node:crypto";
import { z } from "zod";
import { repoFile, routePattern, scrubText } from "./scrub";

/*
 * A bug signal is one sighting of a bug, already reduced to the fields an
 * issue may show and already scrubbed. Inputs are parsed into this shape at
 * the boundary and nothing else from them is kept, so the store, the triage
 * rules and the issue writer never see a raw payload.
 */

type BugFrame = { file: string; line: number | null; fn: string | null };

export type BugSignal = {
  /** Stable identity: one fingerprint, one row, one GitHub issue. */
  fingerprint: string;
  source: "sentry" | "report";
  title: string;
  errorType: string | null;
  message: string | null;
  level: "fatal" | "error" | "warning" | "info";
  /** Route pattern (`/notes/:id`), never a concrete path. */
  route: string | null;
  /** In-app frames only, innermost first, at most eight. */
  frames: BugFrame[];
  /** The Sentry issue link, which the owner can open; Sentry's own access control guards it. */
  sentryIssueUrl: string | null;
  /** What the reporter said went wrong, from a fixed list. */
  reportKind: ReportKind | null;
};

const REPORT_KINDS = ["broken", "wrong", "slow"] as const;
export type ReportKind = (typeof REPORT_KINDS)[number];

const REPORT_TITLES: Record<ReportKind, string> = {
  broken: "Something broke",
  wrong: "Something looks wrong",
  slow: "Something is slow",
};

const MAX_FRAMES = 8;

function fingerprintOf(parts: string[]): string {
  return `bf-${createHash("sha256").update(parts.join("\n")).digest("hex").slice(0, 16)}`;
}

/* ----------------------------- in-app reports ----------------------------- */

export const bugReportInput = z.object({
  route: z.string().max(2048),
  /** The last error boundary digest (or, once Sentry lands, its event id). */
  errorId: z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,64}$/)
    .nullable(),
  kind: z.enum(REPORT_KINDS),
});
export type BugReportInput = z.infer<typeof bugReportInput>;

export function signalFromReport(input: BugReportInput): BugSignal {
  const route = routePattern(input.route);
  return {
    // The kind is not part of the identity: two people who saw the same
    // screen fail and described it differently found one bug.
    fingerprint: fingerprintOf(["report", route, input.errorId ?? "no-error"]),
    source: "report",
    title: `${REPORT_TITLES[input.kind]} on ${route}`,
    errorType: null,
    // A digest is an opaque hash of the server error, not user data; it is
    // the handle the owner greps the server log for.
    message: input.errorId ? `Error boundary digest: ${input.errorId}` : null,
    level: input.errorId ? "error" : "warning",
    route,
    frames: [],
    sentryIssueUrl: null,
    reportKind: input.kind,
  };
}

/* --------------------------------- Sentry --------------------------------- */

const sentryFrame = z.object({
  filename: z.string().nullish(),
  abs_path: z.string().nullish(),
  function: z.string().nullish(),
  lineno: z.number().nullish(),
  in_app: z.boolean().nullish(),
});

/** The fields read from an `event_alert` or `error` event. Everything else is dropped unread. */
const sentryEvent = z.object({
  issue_id: z.union([z.string(), z.number()]).transform(String),
  title: z.string().nullish(),
  level: z.string().nullish(),
  culprit: z.string().nullish(),
  web_url: z.string().nullish(),
  metadata: z.object({ type: z.string().nullish(), value: z.string().nullish() }).nullish(),
  exception: z
    .object({
      values: z
        .array(
          z.object({
            type: z.string().nullish(),
            value: z.string().nullish(),
            stacktrace: z.object({ frames: z.array(sentryFrame).nullish() }).nullish(),
          }),
        )
        .nullish(),
    })
    .nullish(),
  tags: z.array(z.tuple([z.string(), z.string()])).nullish(),
});

export const sentryWebhookBody = z.object({
  data: z.object({ event: sentryEvent.optional(), error: sentryEvent.optional() }),
});

const LEVELS = new Set(["fatal", "error", "warning", "info"]);

export function signalFromSentry(body: z.infer<typeof sentryWebhookBody>): BugSignal | null {
  const event = body.data.event ?? body.data.error;
  if (!event) return null;

  // The last exception is the one that was thrown; Sentry orders the chain
  // cause-first.
  const exception = event.exception?.values?.at(-1);
  const errorType = exception?.type ?? event.metadata?.type ?? null;
  const rawMessage = exception?.value ?? event.metadata?.value ?? null;

  // Sentry orders frames outermost-first; the issue reads innermost-first.
  const frames: BugFrame[] = [];
  for (const frame of [...(exception?.stacktrace?.frames ?? [])].reverse()) {
    const file = repoFile(frame.abs_path) ?? repoFile(frame.filename);
    if (!file) continue;
    frames.push({ file, line: frame.lineno ?? null, fn: frame.function ? scrubText(frame.function) : null });
    if (frames.length === MAX_FRAMES) break;
  }

  const urlTag = event.tags?.find(([key]) => key === "url")?.[1];
  const level = event.level && LEVELS.has(event.level) ? (event.level as BugSignal["level"]) : "error";
  const title = scrubText(event.title ?? [errorType, rawMessage].filter(Boolean).join(": "));

  return {
    fingerprint: fingerprintOf(["sentry", event.issue_id]),
    source: "sentry",
    title: title || "Sentry error",
    errorType: errorType ? scrubText(errorType) : null,
    message: rawMessage ? scrubText(rawMessage) : null,
    level,
    route: urlTag ? routePattern(urlTag) : null,
    frames,
    sentryIssueUrl: safeSentryIssueUrl(event.web_url, event.issue_id),
    reportKind: null,
  };
}

/** Only a sentry.io issue link survives, cut back to the issue (no event id, no query). */
function safeSentryIssueUrl(webUrl: string | null | undefined, issueId: string): string | null {
  if (!webUrl) return null;
  try {
    const url = new URL(webUrl);
    if (url.protocol !== "https:" || !/(^|\.)sentry\.io$/.test(url.hostname)) return null;
    const match = /^(\/organizations\/[\w-]+\/issues\/\d+)\//.exec(`${url.pathname}/`);
    if (!match || !match[1].endsWith(`/${issueId}`)) return null;
    return `${url.origin}${match[1]}/`;
  } catch {
    return null;
  }
}
