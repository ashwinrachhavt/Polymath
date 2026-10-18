import { createHash } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { auditEvents } from "@/domains/audit/schema";
import type { AuthContext } from "@/domains/identity/resolve";
import type { ExtractedField } from "@/integrations/extraction/provider";
import { db } from "@/lib/db";
import { withTransaction } from "@/lib/db-transaction";
import { acceptAssertions } from "./parties";
import { documentParties, fieldProposals } from "./schema";

/*
 * Field proposals: the machine's reading of a document, stored as rows a human
 * decides about. rawValue is always the provider's verbatim output — user
 * corrections land in acceptedValue on the row, never as edits to machine
 * output. Normalization is conservative: an ambiguous value stays unresolved
 * with a note saying why, because a guessed number on an invoice is worse than
 * a blank one.
 */

export type FieldProposalInput = {
  documentId: string;
  extractionId: string;
  fields: ExtractedField[];
  /** Optional currency hint applied only when the raw value carries no currency of its own. */
  currencyHint?: string;
};

/**
 * Persist one extraction's structured fields as proposals. Idempotent per
 * document on (documentId, dedupeKey): a re-run finds its twin and skips it.
 * Lost inserts are success — the other writer proposed the same field.
 */
export async function proposeFields(
  auth: AuthContext,
  input: FieldProposalInput,
): Promise<{ proposed: number; skipped: number }> {
  const rows = input.fields.map((field) => {
    const normalized = normalizeFieldValue(field, input.currencyHint);
    // Conflict notes from flagConflicts ride in on field.normalizationNote;
    // merge them with the normalizer's own note so the flag survives to the
    // row instead of dying at this boundary.
    const note = [field.normalizationNote, normalized.note].filter(Boolean).join("; ") || null;
    return {
      workspaceId: auth.workspaceId,
      documentId: input.documentId,
      extractionId: input.extractionId,
      fieldKind: field.fieldKind,
      fieldName: field.fieldName,
      rawValue: field.rawValue,
      normalizedValue: normalized.normalizedValue,
      normalizationNote: note,
      confidence: field.confidence ?? null,
      dedupeKey: fieldDedupeKey(field),
      evidenceSpans: field.evidenceSpans,
      partyRole: field.partyRole ?? null,
    };
  });
  if (rows.length === 0) return { proposed: 0, skipped: 0 };

  const inserted = await db
    .insert(fieldProposals)
    .values(rows)
    // The (documentId, dedupeKey) unique index is the idempotency; a re-run of
    // the same extraction must not duplicate proposals or revive rejected ones.
    .onConflictDoNothing({
      target: [fieldProposals.documentId, fieldProposals.dedupeKey],
    })
    .returning({ id: fieldProposals.id });

  return { proposed: inserted.length, skipped: rows.length - inserted.length };
}

/*
 * Human decisions on one proposal. Each is one transaction with its audit row:
 * a decision with no audit row did not happen, and an audit row for a decision
 * that rolled back is a lie. The status guard in each WHERE is the idempotency.
 */

const alreadyDecided = () => new Error("field proposal already decided");

/**
 * Accept one proposal, optionally with a typed correction (stored in
 * acceptedValue; rawValue is never edited). When the value was read from a
 * party's block and that party is already linked to a contact or company, the
 * fact lands on that record's assertion ledger in the same transaction, so
 * the order of "link party" and "accept field" does not matter.
 */
export async function acceptFieldProposal(
  auth: AuthContext,
  input: { fieldProposalId: string; acceptedValue?: string | null },
): Promise<{ id: string }> {
  return withTransaction(async (tx) => {
    const [proposal] = await tx
      .select({
        id: fieldProposals.id,
        documentId: fieldProposals.documentId,
        extractionId: fieldProposals.extractionId,
        fieldName: fieldProposals.fieldName,
        normalizedValue: fieldProposals.normalizedValue,
        evidenceSpans: fieldProposals.evidenceSpans,
        partyRole: fieldProposals.partyRole,
        status: fieldProposals.status,
      })
      .from(fieldProposals)
      .where(and(eq(fieldProposals.id, input.fieldProposalId), eq(fieldProposals.workspaceId, auth.workspaceId)))
      .limit(1);
    if (!proposal) throw new Error("field proposal not found in workspace");
    if (proposal.status !== "proposed") throw alreadyDecided();

    // The value is the whole point of a field: an unreadable one needs a typed value.
    const typed = input.acceptedValue?.trim() || null;
    if (proposal.normalizedValue == null && !typed) {
      throw new Error("This value couldn't be read with confidence. Type the value to accept it.");
    }

    const [row] = await tx
      .update(fieldProposals)
      .set({
        status: "accepted",
        acceptedValue: typed,
        decidedAt: new Date(),
        decidedBy: auth.userId,
        updatedAt: new Date(),
        version: sql`${fieldProposals.version} + 1`,
      })
      .where(
        and(
          eq(fieldProposals.id, proposal.id),
          eq(fieldProposals.status, "proposed"),
          eq(fieldProposals.workspaceId, auth.workspaceId),
        ),
      )
      .returning({ id: fieldProposals.id });
    if (!row) throw alreadyDecided();

    if (proposal.partyRole) {
      const [party] = await tx
        .select({ contactId: documentParties.contactId, companyId: documentParties.companyId })
        .from(documentParties)
        .where(
          and(
            eq(documentParties.documentId, proposal.documentId),
            eq(documentParties.workspaceId, auth.workspaceId),
            eq(documentParties.partyRole, proposal.partyRole),
            inArray(documentParties.resolutionStatus, ["matched", "created"]),
          ),
        )
        .limit(1);
      const subjectId = party?.contactId ?? party?.companyId;
      if (party && subjectId) {
        await acceptAssertions(
          auth,
          {
            documentId: proposal.documentId,
            assertions: [
              {
                subjectType: party.contactId ? "contact" : "company",
                subjectId,
                attribute: partyAttribute(proposal.fieldName, proposal.partyRole),
                value: typed ?? proposal.normalizedValue,
                fieldProposalId: proposal.id,
                extractionId: proposal.extractionId,
                evidenceSpans: proposal.evidenceSpans,
              },
            ],
          },
          tx,
        );
      }
    }

    await tx.insert(auditEvents).values({
      workspaceId: auth.workspaceId,
      actorId: auth.userId,
      actorKind: "user",
      action: "field_proposal.accepted",
      subjectType: "field_proposal",
      subjectId: proposal.id,
      summary: `Accepted ${proposal.fieldName}`,
      metadata: { documentId: proposal.documentId, acceptedValue: typed },
    });
    return { id: proposal.id };
  });
}

export async function rejectFieldProposal(
  auth: AuthContext,
  input: { fieldProposalId: string },
): Promise<{ id: string }> {
  return withTransaction(async (tx) => {
    const [row] = await tx
      .update(fieldProposals)
      .set({
        status: "rejected",
        decidedAt: new Date(),
        decidedBy: auth.userId,
        updatedAt: new Date(),
        version: sql`${fieldProposals.version} + 1`,
      })
      .where(
        and(
          eq(fieldProposals.id, input.fieldProposalId),
          eq(fieldProposals.status, "proposed"),
          eq(fieldProposals.workspaceId, auth.workspaceId),
        ),
      )
      .returning({ id: fieldProposals.id, fieldName: fieldProposals.fieldName, documentId: fieldProposals.documentId });
    if (!row) throw alreadyDecided();

    await tx.insert(auditEvents).values({
      workspaceId: auth.workspaceId,
      actorId: auth.userId,
      actorKind: "user",
      action: "field_proposal.rejected",
      subjectType: "field_proposal",
      subjectId: row.id,
      summary: `Rejected ${row.fieldName}`,
      metadata: { documentId: row.documentId },
    });
    return { id: row.id };
  });
}

/*
 * Defer is not a status: the enum's superseded means "replaced by a newer
 * extraction", which a deferral is not. Deferring records that the owner saw
 * the proposal and moved on; the row stays proposed and stays in the queue.
 */
export async function deferFieldProposal(
  auth: AuthContext,
  input: { fieldProposalId: string },
): Promise<{ id: string }> {
  const [row] = await db
    .select({ id: fieldProposals.id, documentId: fieldProposals.documentId, fieldName: fieldProposals.fieldName })
    .from(fieldProposals)
    .where(and(eq(fieldProposals.id, input.fieldProposalId), eq(fieldProposals.workspaceId, auth.workspaceId)))
    .limit(1);
  if (!row) throw new Error("field proposal not found in workspace");

  // A single insert is its own transaction; there is no state change to pair it with.
  await db.insert(auditEvents).values({
    workspaceId: auth.workspaceId,
    actorId: auth.userId,
    actorKind: "user",
    action: "field_proposal.deferred",
    subjectType: "field_proposal",
    subjectId: row.id,
    summary: `Deferred ${row.fieldName}`,
    metadata: { documentId: row.documentId },
  });
  return { id: row.id };
}

/** "recipient_email" read from the recipient's block is that party's "email". */
export function partyAttribute(fieldName: string, partyRole: string): string {
  return fieldName.startsWith(`${partyRole}_`) ? fieldName.slice(partyRole.length + 1) : fieldName;
}

/** Stable per document: same kind+name+value always maps to the same key. */
export function fieldDedupeKey(field: Pick<ExtractedField, "fieldKind" | "fieldName" | "rawValue">) {
  return createHash("sha256")
    .update(`${field.fieldKind}:${field.fieldName}:${field.rawValue}`)
    .digest("hex");
}

/*
 * Normalization — pure functions, exported for tests. Never guesses from
 * document context in v1: an ambiguous date stays null with a note.
 */

export type NormalizedField = {
  normalizedValue: unknown;
  note: string | null;
};

export function normalizeFieldValue(
  field: ExtractedField,
  currencyHint?: string,
): NormalizedField {
  switch (field.fieldKind) {
    case "date":
      return normalizeDate(field.rawValue);
    case "money":
      return normalizeMoney(field.rawValue, currencyHint);
    default:
      // Identifier/text: trimmed raw is the normalized value when unambiguous
      // (single line, no stray interior whitespace runs).
      const trimmed = field.rawValue.trim();
      if (/[\n\r]|\s{2,}/.test(trimmed)) {
        return { normalizedValue: null, note: "raw value not a clean single-line value" };
      }
      return { normalizedValue: trimmed, note: null };
  }
}

export function normalizeDate(raw: string): NormalizedField {
  const value = raw.trim();

  // Unambiguous first: ISO and long-form month names.
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (iso) return { normalizedValue: value, note: null };
  const longForm = /^(\d{1,2}) ([A-Za-z]+) (\d{4})$/.exec(value);
  if (longForm && !Number.isNaN(Date.parse(`1 ${longForm[2]} 2000`))) {
    const month = String(new Date(`1 ${longForm[2]} 2000`).getMonth() + 1).padStart(2, "0");
    return { normalizedValue: `${longForm[3]}-${month}-${longForm[1].padStart(2, "0")}`, note: null };
  }
  const monthFirst = /^([A-Za-z]+) (\d{1,2}),? (\d{4})$/.exec(value);
  if (monthFirst && !Number.isNaN(Date.parse(`1 ${monthFirst[1]} 2000`))) {
    const month = String(new Date(`1 ${monthFirst[1]} 2000`).getMonth() + 1).padStart(2, "0");
    return { normalizedValue: `${monthFirst[3]}-${month}-${monthFirst[2].padStart(2, "0")}`, note: null };
  }

  // Numeric d/m/y: ambiguous unless the month part is > 12. Never guess.
  const numeric = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(value);
  if (numeric) {
    const a = Number(numeric[1]);
    const b = Number(numeric[2]);
    if (a > 12 && b <= 12) {
      return { normalizedValue: `${numeric[3]}-${pad2(b)}-${pad2(a)}`, note: null };
    }
    if (b > 12 && a <= 12) {
      return { normalizedValue: `${numeric[3]}-${pad2(a)}-${pad2(b)}`, note: null };
    }
    return {
      normalizedValue: null,
      note: "date format ambiguous (dd/mm vs mm/dd)",
    };
  }

  return { normalizedValue: null, note: "unrecognized date format" };
}

export function normalizeMoney(raw: string, currencyHint?: string): NormalizedField {
  const value = raw.trim();

  // Currency only from explicit evidence in the raw text or a supplied hint —
  // never defaulted to USD.
  let currency: string | null = null;
  const symbol = /^([£€$¥])/.exec(value) ?? /([£€$¥])$/.exec(value);
  if (symbol) currency = { "£": "GBP", "€": "EUR", $: "USD", "¥": "JPY" }[symbol[1]] ?? null;
  const code = /\b([A-Z]{3})\b/.exec(value);
  if (!currency && code && KNOWN_CURRENCIES.has(code[1])) currency = code[1];
  if (!currency && currencyHint) currency = currencyHint;

  // Numeric amount: first number in the text, stripping separators. Negative
  // and parenthesised negatives both honored.
  const negative = /^\(.*\)$/.test(value) || value.includes("-");
  const amount = parseAmount(value);
  if (amount === null) return { normalizedValue: null, note: "no numeric amount found" };

  return {
    normalizedValue: { amount: negative ? -Math.abs(amount) : amount, currency },
    note: null,
  };
}

const KNOWN_CURRENCIES = new Set([
  "USD", "EUR", "GBP", "JPY", "CHF", "CAD", "AUD", "NZD", "SEK", "NOK", "DKK",
  "INR", "CNY", "SGD", "HKD", "ZAR",
]);

/** First number in a money string, separators stripped; null when none. One
 * parser for normalizeMoney and flagConflicts — a fix to separator handling
 * lands once, not three times. */
function parseAmount(raw: string): number | null {
  const match = /[\d][\d.,]*\d|[\d]/.exec(raw.replace(/[()]/g, ""));
  if (!match) return null;
  const amount = Number(match[0].replace(/,/g, ""));
  return Number.isNaN(amount) ? null : amount;
}

function pad2(n: number) {
  return String(n).padStart(2, "0");
}

/**
 * Cross-field validation, never repair: where the numbers disagree with each
 * other, the note records it and both values are left untouched.
 */
export function flagConflicts(fields: ExtractedField[]): ExtractedField[] {
  const money = fields.filter((f) => f.fieldKind === "money");
  const lineItems = money.filter((f) => f.fieldName.toLowerCase() !== "total");
  const total = money.find((f) => f.fieldName.toLowerCase() === "total");
  if (!total || lineItems.length < 2) return fields;

  const sum = lineItems.reduce((acc, f) => acc + (parseAmount(f.rawValue) ?? 0), 0);
  const totalValue = parseAmount(total.rawValue);
  if (totalValue === null) return fields;

  if (Math.abs(sum - totalValue) > 0.005) {
    return fields.map((f) =>
      f.fieldKind === "money" && (f === total || lineItems.includes(f))
        ? {
            ...f,
            normalizationNote: [
              f.normalizationNote,
              `line items sum to ${sum} but stated total is ${totalValue}`,
            ]
              .filter(Boolean)
              .join("; "),
          }
        : f,
    );
  }
  return fields;
}
