import { and, eq, isNull, or, sql } from "drizzle-orm";
import { recordAudit } from "@/domains/audit/record";
import type { AuthContext } from "@/domains/identity/resolve";
import { JevUnconfiguredError, type JevAnswer } from "@/integrations/jev/client";
import { JevDisabledError, jevClassifier, type ClassifyJudger } from "@/integrations/jev/provider";
import { captureKindQuestions } from "@/integrations/jev/questions";
import { QuotaExhaustedError } from "@/integrations/providers/quota";
import { providerEntry } from "@/integrations/providers/registry";
import { db } from "@/lib/db";
import { withTransaction } from "@/lib/db-transaction";
import { LLM_MAX_INPUT_CHARS } from "./classification";
import { workingText } from "./mode";
import { captures } from "./schema";

/*
 * What a capture is, as the Inbox labels it. Three deciders, in order:
 *
 *   rules  free and certain: a bare link, a checkbox or a dated to-do, a
 *          quotation with its source, a contact block
 *   jev    one paid judgment for what the rules cannot name, through the
 *          registry entry and the workspace's monthly jev allowance
 *   user   the person's correction, which nothing automatic overwrites
 *
 * `kind_source` records which decided. A spent allowance stores no label,
 * only the reason, so the Inbox can say "Not classified" honestly instead of
 * guessing.
 */

export const CAPTURE_KINDS = ["article", "idea", "task", "person", "reference", "quote", "other"] as const;
export type CaptureKind = (typeof CAPTURE_KINDS)[number];

function isCaptureKind(value: unknown): value is CaptureKind {
  return typeof value === "string" && (CAPTURE_KINDS as readonly string[]).includes(value);
}

/** Stored with no label when the jev allowance is spent; the Inbox shows it as the tooltip. */
const BUDGET_REASON = "Classification budget used this month — set it by hand.";
const USER_REASON = "Set by you.";
/** Below this, Jev's top pick is a guess, and the honest label is "other". */
const JEV_MIN_PROBABILITY = 0.5;

const BARE_ADDRESS = /^https?:\/\/\S+$/i;
const CHECKBOX = /^\s*(?:[-*]\s*)?\[ \]\s+\S/;
const QUOTED_WITH_SOURCE = /^["“]([^"”]{2,})["”]\s*[-–—―~]+\s*\S/;
const ACTION_VERBS = new Set(
  (
    "ask book buy call cancel check clean confirm draft email file finish fix follow get invite make meet message " +
    "order pay pick plan prepare print publish read register remind renew reply return review schedule send " +
    "share ship sign submit text update upload write"
  ).split(" "),
);
const WEEKDAY = "(?:mon|tues|wednes|thurs|fri|satur|sun)day";
const MONTH = "(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\\.?\\s+\\d{1,2}";
const DUE_PHRASE = new RegExp(
  `\\b(?:today|tonight|tomorrow|(?:by|before|due|until|on)\\s+(?:${WEEKDAY}|${MONTH}|noon|eod|eow|end of (?:the )?(?:day|week|month)|(?:this|next)\\s+(?:week|month|${WEEKDAY})|\\d{1,2}(?:[/.-]\\d{1,2})?(?:\\s?[ap]m)?))\\b`,
  "i",
);

/**
 * The rules tier: a kind and the reason when the capture's shape settles it,
 * null when only reading the words could. `text` is what the person sent, not
 * a fetched page, so a link with a note of theirs is not "just a link".
 */
export function ruleKind(input: {
  text: string;
  url: string | null;
  structure: string | null;
}): { kind: CaptureKind; reason: string } | null {
  const text = input.text.trim();
  if (input.structure === "contact") return { kind: "person", reason: "Contact details for someone." };
  if ((input.url && (!text || text === input.url)) || BARE_ADDRESS.test(text)) {
    return { kind: "article", reason: "A link with nothing written beside it." };
  }
  if (CHECKBOX.test(text)) return { kind: "task", reason: "Written as a to-do checkbox." };
  if (QUOTED_WITH_SOURCE.test(text)) return { kind: "quote", reason: "Words in quotation marks with who said them." };
  const firstWord = text
    .replace(/^please\s+/i, "")
    .split(/\s/, 1)[0]
    ?.toLowerCase();
  if (firstWord && ACTION_VERBS.has(firstWord) && DUE_PHRASE.test(text)) {
    return { kind: "task", reason: "Starts with something to do and says when." };
  }
  return null;
}

type KindLabelOutcome = {
  kind: CaptureKind | null;
  source: "rules" | "jev" | "user" | null;
  skipped: "budget" | "disabled" | null;
};

const UNLABELED: KindLabelOutcome = { kind: null, source: null, skipped: null };

/** Nothing automatic may write over the person's own choice. */
const notSetByUser = or(isNull(captures.kindSource), sql`${captures.kindSource} <> 'user'`);

async function storeLabel(
  auth: AuthContext,
  captureId: string,
  label: { kind: CaptureKind; reason: string; source: "rules" | "jev" },
) {
  await db
    .update(captures)
    .set({ kindLabel: label.kind, kindReason: label.reason, kindSource: label.source })
    .where(and(eq(captures.workspaceId, auth.workspaceId), eq(captures.id, captureId), notSetByUser));
}

/**
 * Label one capture, rules first, then Jev. Jev is asked only when the rules
 * cannot name it, the capture has words to read, and the jev entry is usable
 * (an injected judger, or the registry entry enabled); the request goes
 * through the quota ledger. A label the person set is returned untouched.
 *
 * Skips are outcomes, not errors: `disabled` stores nothing (the deployment
 * runs without Jev, or set it no allowance); `budget` stores only the reason,
 * and keeps any earlier label. A Jev request error propagates so the caller's
 * event redelivers. Writes never bump the capture's version: the label is
 * its own axis, and an open editor must not go stale because a label landed.
 */
export async function labelCaptureKind(
  auth: AuthContext,
  captureId: string,
  deps: { judger?: ClassifyJudger } = {},
): Promise<KindLabelOutcome> {
  const [capture] = await db
    .select({
      text: captures.text,
      url: captures.url,
      title: captures.title,
      structure: captures.structure,
      cleanText: captures.cleanText,
      fetchedText: captures.fetchedText,
      captureMode: captures.captureMode,
      kindLabel: captures.kindLabel,
      kindSource: captures.kindSource,
    })
    .from(captures)
    .where(and(eq(captures.workspaceId, auth.workspaceId), eq(captures.id, captureId)))
    .limit(1);
  if (!capture) return UNLABELED;
  if (capture.kindSource === "user" && isCaptureKind(capture.kindLabel)) {
    return { kind: capture.kindLabel, source: "user", skipped: null };
  }

  // A page grab or a bare link carries the page as its text (the fetch writes
  // it there); none of it is the person's own words, so the rules see a link.
  const ownWords = capture.captureMode === "page" || capture.captureMode === "url-reference" ? "" : capture.text;
  const rule = ruleKind({ text: ownWords ?? "", url: capture.url, structure: capture.structure });
  if (rule) {
    await storeLabel(auth, captureId, { ...rule, source: "rules" });
    return { kind: rule.kind, source: "rules", skipped: null };
  }

  const reading = (capture.cleanText ?? workingText(capture) ?? "").trim();
  if (!reading) return UNLABELED;
  if (!deps.judger && !providerEntry("jev")?.enabled) return { ...UNLABELED, skipped: "disabled" };
  const judger = deps.judger ?? jevClassifier(auth.workspaceId);

  let answer: JevAnswer | undefined;
  try {
    const result = await judger.judge({
      state: JSON.stringify({
        title: capture.title ?? undefined,
        text: reading.slice(0, LLM_MAX_INPUT_CHARS),
        url: capture.url ?? undefined,
      }),
      questions: captureKindQuestions(),
    });
    answer = result.answers.kind;
  } catch (cause) {
    // An allowance of zero is "no budget set", the deployment's choice, not a spent month.
    if (cause instanceof QuotaExhaustedError && cause.allowance > 0) {
      await db
        .update(captures)
        .set({ kindReason: BUDGET_REASON })
        .where(and(eq(captures.workspaceId, auth.workspaceId), eq(captures.id, captureId), isNull(captures.kindLabel)));
      return { ...UNLABELED, skipped: "budget" };
    }
    if (
      cause instanceof QuotaExhaustedError ||
      cause instanceof JevDisabledError ||
      cause instanceof JevUnconfiguredError
    ) {
      return { ...UNLABELED, skipped: "disabled" };
    }
    throw cause;
  }

  // An answer that is not a choice is unreadable: store nothing rather than guess.
  if (!answer || answer.type !== "choice") return UNLABELED;
  const probability = answer.probabilities[answer.choice] ?? answer.confidence;
  const pick = isCaptureKind(answer.choice) && probability >= JEV_MIN_PROBABILITY ? answer.choice : null;
  const label = pick
    ? { kind: pick, reason: `Read from the wording (${Math.round(probability * 100)}% sure).` }
    : { kind: "other" as const, reason: "No kind clearly fits." };
  await storeLabel(auth, captureId, { ...label, source: "jev" });
  return { kind: label.kind, source: "jev", skipped: null };
}

/** The person's correction. Returns false when the capture is not in this workspace. */
export async function setCaptureKind(auth: AuthContext, input: { captureId: string; kind: CaptureKind }) {
  return withTransaction(async (tx) => {
    const [updated] = await tx
      .update(captures)
      .set({ kindLabel: input.kind, kindReason: USER_REASON, kindSource: "user", updatedBy: auth.userId })
      .where(and(eq(captures.workspaceId, auth.workspaceId), eq(captures.id, input.captureId)))
      .returning({ id: captures.id });
    if (!updated) return false;
    await recordAudit(
      auth,
      {
        action: "capture.kind_set",
        subjectType: "capture",
        subjectId: updated.id,
        summary: `Kind set to ${input.kind}`,
      },
      tx,
    );
    return true;
  });
}
