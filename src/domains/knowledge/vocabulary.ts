/*
 * One vocabulary, three consumers (ASH-133 items 1-2, ASH-143 B02).
 *
 * Canonical field names: provider field names arrive as anything ("Invoice
 * Total", "grand_total"); the rules proposer already emits the canonical
 * names. Both are alias-mapped here at the extraction boundary, so the
 * obligation rules and the totals check stop disagreeing about the same
 * field. An unknown name survives normalized (lowercase, underscored) - it is
 * aliased, never fabricated or dropped.
 *
 * Document types: the one doc-type signal. Classification proposes it, the
 * owner accepts it, documents.doc_type stores it; obligations and title
 * suggestions consume it instead of regexing the mutable title string.
 */

export const documentTypes = [
  "invoice",
  "receipt",
  "agreement",
  "resume",
  "statement",
  "letter",
  "report",
  "form",
  "other",
] as const;
export type DocumentType = (typeof documentTypes)[number];

const FIELD_ALIASES: Record<string, string> = {
  // Money totals: one canonical total; subtotal and tax stay distinct lines.
  total: "invoice_total",
  grand_total: "invoice_total",
  total_due: "invoice_total",
  total_amount: "invoice_total",
  amount_due: "invoice_total",
  balance_due: "invoice_total",
  amount_payable: "invoice_total",
  sub_total: "subtotal",
  vat: "tax",
  gst: "tax",
  sales_tax: "tax",
  // Dates.
  date: "issue_date",
  invoice_date: "issue_date",
  payment_due: "due_date",
  payment_due_date: "due_date",
  due_by: "due_date",
  due_on: "due_date",
  start_date: "effective_date",
  end_date: "expiration_date",
  expiry_date: "expiration_date",
  renewal_date: "renewal_date",
  // Identifiers and parties.
  invoice_id: "invoice_number",
  invoice_no: "invoice_number",
  inv_number: "invoice_number",
  from: "issuer",
  vendor: "issuer",
  seller: "issuer",
  bill_to: "recipient",
  billed_to: "recipient",
  full_name: "person",
  candidate: "person",
  job_title: "role",
  position: "role",
};

/** Provider noise ("  Invoice Total ") to the comparable key ("invoice_total"). */
export const normalizeFieldKey = (name: string): string =>
  name.trim().toLowerCase().replace(/[\s\-./]+/g, "_").replace(/^_+|_+$/g, "");

export function canonicalFieldName(name: string): string {
  const key = normalizeFieldKey(name);
  return FIELD_ALIASES[key] ?? key;
}

export type DocumentClassification = {
  docType: DocumentType;
  confidence: "high" | "medium" | "low";
  /** The matched signals, recorded on the proposal so the review shows why. */
  signals: string[];
};

type ClassifyInput = {
  text: string;
  fieldNames: string[];
  filename?: string | null;
};

const has = (fields: Set<string>, ...names: string[]) => names.some((n) => fields.has(n));

/**
 * The rules classifier. Conservative by design: a document that matches
 * nothing is "other" with low confidence, and every call names its signals so
 * the review manifest shows the basis. A model proposer plugs in behind the
 * same proposal row later - output stays a proposal either way.
 */
export function classifyDocument(input: ClassifyInput): DocumentClassification {
  const fields = new Set(input.fieldNames.map(canonicalFieldName));
  const text = input.text.toLowerCase();
  const name = (input.filename ?? "").toLowerCase();
  const mentions = (re: RegExp) => re.test(text) || re.test(name);

  // Invoice: the identifier plus a total is the strongest pair we know.
  if (has(fields, "invoice_number") && has(fields, "invoice_total")) {
    return { docType: "invoice", confidence: "high", signals: ["invoice_number", "invoice_total"] };
  }
  if (has(fields, "invoice_number", "invoice_total") && mentions(/\binvoice\b/)) {
    const signal = has(fields, "invoice_number") ? "invoice_number" : "invoice_total";
    return { docType: "invoice", confidence: "medium", signals: [signal, "word:invoice"] };
  }
  if (mentions(/\bagreement\b|\bcontract\b|\bterms and conditions\b/) && has(fields, "effective_date", "party_a", "party_b")) {
    return { docType: "agreement", confidence: "medium", signals: ["word:agreement", "party/date fields"] };
  }
  if (mentions(/\bagreement\b/) && mentions(/\bparties\b|\bbetween\b/)) {
    return { docType: "agreement", confidence: "medium", signals: ["word:agreement", "word:parties"] };
  }
  if (
    mentions(/\b(curriculum vitae|résumé|resume)\b/) ||
    (mentions(/\b(work )?experience\b/) && mentions(/\beducation\b/) && mentions(/\bskills\b/))
  ) {
    return { docType: "resume", confidence: "medium", signals: ["resume sections"] };
  }
  if (mentions(/\breceipt\b|\bpayment received\b/) && has(fields, "invoice_total", "amount_paid")) {
    return { docType: "receipt", confidence: "medium", signals: ["word:receipt", "money field"] };
  }
  // Bank statements: the balances the statement prints about itself are the
  // strongest signal, then its own structural vocabulary. One weak word alone
  // stays a low-confidence proposal.
  const openingBalance = mentions(/\b(beginning|opening)\s+balance\b/);
  const closingBalance = mentions(/\b(ending|closing|current)\s+balance\b/);
  const statementPeriod = mentions(/\bstatement\s+period\b|\bbilling\s+period\b/);
  const transactionLedger = mentions(/\btransaction\s+(details|history|activity)\b|\baccount\s+activity\b/);
  if ((openingBalance && closingBalance) || (statementPeriod && (openingBalance || closingBalance))) {
    const signals = [
      ...(openingBalance ? ["opening balance"] : []),
      ...(closingBalance ? ["closing balance"] : []),
      ...(statementPeriod ? ["statement period"] : []),
    ];
    return { docType: "statement", confidence: "high", signals };
  }
  if (statementPeriod || transactionLedger || ((openingBalance || closingBalance) && mentions(/\baccount\b/))) {
    const signal = statementPeriod
      ? "statement period"
      : transactionLedger
        ? "transaction ledger"
        : "balance line";
    return { docType: "statement", confidence: "medium", signals: [signal] };
  }
  if (mentions(/\bstatement\b|\baccount balance\b|\bbilling period\b/)) {
    return { docType: "statement", confidence: "low", signals: ["word:statement"] };
  }
  return { docType: "other", confidence: "low", signals: [] };
}
