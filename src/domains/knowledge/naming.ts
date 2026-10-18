import { and, eq, sql } from "drizzle-orm";
import type { AuthContext } from "@/domains/identity/resolve";
import { db } from "@/lib/db";
import { documents } from "./schema";

/*
 * Document titles. suggestTitle is pure and conservative: a field that is
 * missing is omitted, never fabricated as "unknown" — a title that says
 * "unknown" is a lie the user has to correct. applyTitle is a version-checked
 * mutation; the original filename on files stays untouched because it is the
 * provenance record, not a display name.
 */

type Fields = Record<string, string | null | undefined>;

/** First non-empty value for any of the given keys. */
const pick = (fields: Fields, ...keys: string[]) => {
  for (const k of keys) {
    const v = fields[k]?.trim();
    if (v) return v;
  }
  return null;
};

/** Uppercase the first character; the one capitalizer this file uses. */
const capitalize = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);

/** Drop empty segments and adjacent separators; sentence-case the whole line. */
const join = (parts: (string | null)[]) => {
  const title = parts
    .filter((p): p is string => Boolean(p && p.trim()))
    .map((p) => p.trim())
    .join(" — ");
  return capitalize(title);
};

/**
 * A doc type shouted in ALL-CAPS ("SERVICES_AGREEMENT") reads sentence-cased;
 * mixed-case names like "OpenAI" are left alone. Party names never go through
 * this — mangling a provenance name is worse than a loud one.
 */
const cap = capitalize;

export function sentenceCase(value: string): string {
  const trimmed = value.trim();
  if (!/^[A-Z0-9\s'-]+$/.test(trimmed) || !/[A-Z]/.test(trimmed)) return trimmed;
  return capitalize(trimmed.toLowerCase());
}

export function suggestTitle(docType: string, fields: Fields): string {
  const date = pick(fields, "date", "invoice_date", "effective_date", "agreement_date");

  if (/invoice/i.test(docType)) {
    const issuer = pick(fields, "issuer", "from", "vendor", "seller", "company");
    const number = pick(fields, "number", "invoice_number", "invoice_id");
    return join([issuer, `Invoice${number ? ` ${number}` : ""}`, date]);
  }

  if (/resume|cv|curriculum/i.test(docType)) {
    const person = pick(fields, "person", "name", "full_name", "candidate");
    const role = pick(fields, "role", "position", "target_role", "job_title");
    const version = pick(fields, "version")?.replace(/^v/i, "");
    const core = role ? `${role} résumé` : "Résumé";
    const title = join([person, core]);
    return version ? `${title} v${version}` : title;
  }

  // Agreements, contracts, statements, anything else: parties + type + date + status.
  const type = cap(sentenceCase(docType.replace(/[_-]+/g, " ")));
  const partyA = pick(fields, "party_a", "first_party", "issuer", "sender", "company", "person", "name");
  const partyB = pick(fields, "party_b", "second_party", "recipient", "client", "counterparty");
  const status = pick(fields, "status", "agreement_status");
  return join([join([partyA, partyB]), type, date, status]);
}

/** Version-checked rename of documents.title. The filename on files is untouched. */
export async function applyTitle(
  auth: AuthContext,
  input: { documentId: string; title: string; expectedVersion: number },
) {
  const [row] = await db
    .update(documents)
    .set({
      title: input.title.trim(),
      updatedAt: new Date(),
      updatedBy: auth.userId,
      version: sql`${documents.version} + 1`,
    })
    .where(
      and(
        eq(documents.id, input.documentId),
        eq(documents.workspaceId, auth.workspaceId),
        eq(documents.version, input.expectedVersion),
      ),
    )
    .returning();
  if (!row) throw new Error("document not found, stale version, or title unchanged");
  return row;
}
