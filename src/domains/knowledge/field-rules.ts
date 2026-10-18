import type { ExtractedField, ExtractionSpan } from "@/integrations/extraction/provider";
import { normalizeDate, normalizeMoney } from "./fields";
import type { PartyCandidate } from "./parties";

/*
 * The text-to-proposals bridge: deterministic label rules over extracted text,
 * never a model. Neither extraction provider emits structured fields, so this
 * is where invoice-shaped paperwork gets its reviewable fields and parties.
 *
 * Only labelled values are proposed ("Due date: ...", "Bill to:"); an
 * unlabelled number is never guessed into a field. Every proposal carries the
 * exact character span it was read from, and confidence says how sure the
 * rule is about the value — an ambiguous date or a repeated label with
 * different values is "low", and its normalizedValue stays null so the review
 * guard makes the owner type it.
 *
 * Ceiling: line-oriented. Side-by-side columns (From | Bill to on one line)
 * interleave in text extraction and are not split; a layout-aware extractor
 * is the upgrade when real documents need it.
 */

export const RULES_PROPOSER = "text-rules@1";

type Role = NonNullable<ExtractedField["partyRole"]>;

type ScalarRule = {
  fieldName: string;
  fieldKind: "date" | "money" | "identifier";
  label: RegExp;
};

// Order matters: first match wins, so "Total due" is money before "Due" is a date.
const SCALAR_RULES: ScalarRule[] = [
  { fieldName: "subtotal", fieldKind: "money", label: /sub-?\s?total/ },
  { fieldName: "tax", fieldKind: "money", label: /(?:vat|gst|sales tax|tax)(?:\s*\(?\d+(?:[.,]\d+)?\s*%\)?)?/ },
  {
    fieldName: "invoice_total",
    fieldKind: "money",
    label: /(?:total due|amount due|balance due|grand total|total amount|invoice total|amount payable|total)/,
  },
  { fieldName: "due_date", fieldKind: "date", label: /(?:payment due date|due date|payment due|due by|due on|due)/ },
  { fieldName: "issue_date", fieldKind: "date", label: /(?:invoice date|issue date|date of issue|issued on|issued|date)/ },
  { fieldName: "invoice_number", fieldKind: "identifier", label: /(?:invoice\s*(?:number|num\.?|no\.?|#)|inv\.?\s*(?:no\.?|#))/ },
  {
    fieldName: "reference_number",
    fieldKind: "identifier",
    label: /(?:purchase order(?:\s*(?:number|no\.?|#))?|po\s*(?:number|no\.?|#)|our ref(?:erence)?|your ref(?:erence)?|reference|ref\.?)/,
  },
];

const PARTY_LABELS: Array<{ role: Role; label: RegExp }> = [
  { role: "recipient", label: /(?:bill(?:ed)? to|invoice to|sold to|ship to|recipient|customer|client|to)/ },
  { role: "issuer", label: /(?:bill(?:ed)? by|bill from|issued by|from|issuer|seller|supplier|vendor)/ },
];

const CURRENCY_LABEL = /currency/;

// Leading markdown/table noise a provider may wrap a label in ("**Total:**", "| Total |").
const PREFIX = String.raw`^[\s#>*_|]*`;
const SEPARATOR = String.raw`[\s*_]*(?::|#|\|)?[\s*_|]*`;

function labelled(line: string, label: RegExp): string | null {
  const match = new RegExp(`${PREFIX}(?:${label.source})(?![A-Za-z0-9])${SEPARATOR}(.*)$`, "i").exec(line);
  return match ? match[1].replace(/[\s*_|]+$/, "").trim() : null;
}

/** Party labels need a colon or a line of their own: "To be paid in 30 days" is prose. */
function partyLabelled(line: string, label: RegExp): string | null {
  const match = new RegExp(`${PREFIX}(?:${label.source})(?![A-Za-z0-9])[\\s*_]*(?::[\\s*_|]*(.*)|[\\s*_|]*$)`, "i").exec(line);
  return match ? (match[1] ?? "").replace(/[\s*_|]+$/, "").trim() : null;
}

const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const HAS_EMAIL = new RegExp(EMAIL.source, "i");
// An amount, optionally with one currency symbol or code on either side; anything else is not money.
const AMOUNT = /^\(?-?\s*(?:[£€$¥]|[A-Z]{3})?\s*-?\d[\d,]*(?:\.\d+)?\s*(?:[£€$¥]|[A-Z]{3})?\)?$/;
const COMPANY_HINT =
  /\b(?:ltd|limited|llc|l\.l\.c\.|inc|incorporated|corp|corporation|company|co\.|gmbh|ag|plc|llp|bv|sarl|srl|pty|group|services|partners|associates|studio|carpentry|plumbing)\b/i;
const MONEY_LIKE = /\d[\d,]*\.\d{2}\b/;

export type TextProposals = {
  fields: ExtractedField[];
  parties: PartyCandidate[];
  /** An explicit "Currency: EUR" line, applied only to amounts that carry none. */
  currencyHint?: string;
};

type Line = { text: string; start: number };

function splitLines(text: string): Line[] {
  const lines: Line[] = [];
  let start = 0;
  for (const part of text.split("\n")) {
    lines.push({ text: part.replace(/\r$/, ""), start });
    start += part.length + 1;
  }
  return lines;
}

function pageOf(offset: number, pages: ExtractionSpan[]): number {
  return pages.find((p) => offset >= p.start && offset < p.end)?.page ?? 1;
}

function isLabelLine(text: string) {
  return (
    SCALAR_RULES.some((r) => labelled(text, r.label) !== null) ||
    PARTY_LABELS.some((p) => partyLabelled(text, p.label) !== null) ||
    labelled(text, CURRENCY_LABEL) !== null
  );
}

export function proposeFromText(text: string, pages: ExtractionSpan[] = []): TextProposals {
  const lines = splitLines(text);
  const fields: ExtractedField[] = [];
  const parties: PartyCandidate[] = [];
  let currencyHint: string | undefined;

  const span = (line: Line, value: string) => {
    const start = line.start + line.text.lastIndexOf(value);
    return { page: pageOf(start, pages), start, end: start + value.length };
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    const currency = labelled(line.text, CURRENCY_LABEL);
    if (currency && /^[A-Z]{3}$/.test(currency)) {
      currencyHint = currency;
      continue;
    }

    const party = PARTY_LABELS.map((p) => ({ ...p, value: partyLabelled(line.text, p.label) })).find(
      (p) => p.value !== null,
    );
    if (party) {
      // The block: the label line's own value, then following lines up to the
      // next label or an amount. Values inside it describe this party.
      const block: Line[] = [];
      if (party.value) block.push({ text: party.value, start: line.start + line.text.lastIndexOf(party.value) });
      for (let j = i + 1; j < lines.length && block.length < 5; j++) {
        const next = lines[j];
        if (!next.text.trim()) {
          if (block.length) break;
          continue;
        }
        if (isLabelLine(next.text) || MONEY_LIKE.test(next.text)) break;
        block.push(next);
      }

      const nameLine = block.find((l) => /[A-Za-z]/.test(l.text) && !HAS_EMAIL.test(l.text));
      const emails = block.flatMap((l) =>
        [...l.text.matchAll(EMAIL)].map((m) => ({ value: m[0], start: l.start + (m.index ?? 0) })),
      );
      if (nameLine) {
        const name = nameLine.text.trim();
        const isCompany = COMPANY_HINT.test(name);
        parties.push({
          partyRole: party.role,
          partyKind: isCompany ? "company" : "contact",
          displayName: name,
          evidenceSpans: [span(nameLine, name)],
          email: !isCompany ? emails[0]?.value : undefined,
        });
      }
      for (const email of emails) {
        fields.push({
          fieldKind: "identifier",
          fieldName: `${party.role}_email`,
          rawValue: email.value,
          confidence: "high",
          partyRole: party.role,
          evidenceSpans: [
            { page: pageOf(email.start, pages), start: email.start, end: email.start + email.value.length },
          ],
        });
      }
      continue;
    }

    for (const rule of SCALAR_RULES) {
      const value = labelled(line.text, rule.label);
      if (value === null) continue;
      // First matching label owns the line; a value that does not fit the kind proposes nothing.
      if (!/\d/.test(value) || (rule.fieldKind === "money" && !AMOUNT.test(value))) break;
      fields.push({
        fieldKind: rule.fieldKind,
        fieldName: rule.fieldName,
        rawValue: value,
        confidence: confidenceFor(rule.fieldKind, value),
        evidenceSpans: [span(line, value)],
      });
      break;
    }
  }

  // Money confidence depends on the document-level currency line, which may
  // come after the amount; settle it once everything has been read.
  for (const field of fields) {
    if (field.fieldKind === "money" && field.confidence === "medium" && currencyHint) field.confidence = "high";
  }

  return { fields: flagRepeatedLabels(fields), parties, currencyHint };
}

function confidenceFor(kind: ScalarRule["fieldKind"], value: string): string {
  if (kind === "date") return normalizeDate(value).normalizedValue == null ? "low" : "high";
  if (kind === "money") {
    const normalized = normalizeMoney(value).normalizedValue as { currency: string | null } | null;
    if (!normalized) return "low";
    return normalized.currency ? "high" : "medium";
  }
  return /^[A-Z0-9][A-Z0-9\-/.]*$/i.test(value) ? "high" : "medium";
}

/** The same label read twice with different values is a conflict, not a choice the rules make. */
function flagRepeatedLabels(fields: ExtractedField[]): ExtractedField[] {
  const valuesByName = new Map<string, Set<string>>();
  for (const f of fields) {
    valuesByName.set(f.fieldName, (valuesByName.get(f.fieldName) ?? new Set()).add(f.rawValue));
  }
  return fields.map((f) =>
    (valuesByName.get(f.fieldName)?.size ?? 0) > 1
      ? {
          ...f,
          confidence: "low",
          normalizationNote: `"${f.fieldName}" appears more than once with different values`,
        }
      : f,
  );
}
