/*
 * DRAFT candidate evaluation questions for issue #533 Phase 1. ALL entries
 * are drafts awaiting the owner's manual review and labeling before they
 * count as the issue's "manually reviewed questions". Categories follow the
 * issue: exact identifiers, paraphrases, multiple distant sections,
 * cross-document comparison, scans/partial indexing, stale versions, and
 * scope boundaries. Split: ~70% dev / ~30% heldout (deterministic by index).
 */

type Expected = { docKey: string; fragment: string };
export type EvalQuestion = {
  id: string;
  question: string;
  category:
    | "exact_identifier"
    | "paraphrase"
    | "multi_section"
    | "cross_document"
    | "unanswerable"
    | "stale_version"
    | "partial_indexing"
    | "scope_boundary";
  /** Passages a correct retrieval must surface (substring match within a returned chunk). */
  expected: Expected[];
  /** When true, the correct retrieval is empty (or at least contains none of `forbidden`). */
  unanswerable?: boolean;
  /** Fragments that must NOT appear (archived/foreign content probes). */
  forbidden?: Expected[];
  split: "dev" | "heldout";
};

type Base = Omit<EvalQuestion, "id" | "split">;

const BASE: Base[] = [
  // --- exact identifiers ---
  { question: "What is the lease reference number for the Market Street office?", category: "exact_identifier", expected: [{ docKey: "lease", fragment: "LSE-2024-1187" }] },
  { question: "What is the payroll policy document code?", category: "exact_identifier", expected: [{ docKey: "payroll", fragment: "HR-PAY-0042" }] },
  { question: "What is the contract number of the Acme supply agreement?", category: "exact_identifier", expected: [{ docKey: "vendor", fragment: "MSA-2023-0551" }] },
  { question: "What amount is due on the IRS CP-14 notice?", category: "exact_identifier", expected: [{ docKey: "tax", fragment: "$3,212.45" }] },
  { question: "Which resolution approved the annual operating budget?", category: "exact_identifier", expected: [{ docKey: "minutes", fragment: "Resolution 2025-07" }] },
  // --- paraphrases ---
  { question: "How much rent do we pay each month for the San Francisco office?", category: "paraphrase", expected: [{ docKey: "lease", fragment: "$8,400" }] },
  { question: "When does payroll run?", category: "paraphrase", expected: [{ docKey: "payroll", fragment: "fifteenth and the last day" }] },
  { question: "How is overtime compensated for non-exempt staff?", category: "paraphrase", expected: [{ docKey: "payroll", fragment: "one and a half times" }] },
  { question: "How much is the remote work internet stipend?", category: "paraphrase", expected: [{ docKey: "handbook-long", fragment: "$75" }] },
  { question: "What is the liability cap in our supplier agreement?", category: "paraphrase", expected: [{ docKey: "vendor", fragment: "twelve months preceding the claim" }] },
  { question: "How many paid days off do employees get when a close relative dies?", category: "paraphrase", expected: [{ docKey: "handbook-long", fragment: "five paid days" }] },
  { question: "When do expense reimbursements arrive?", category: "paraphrase", expected: [{ docKey: "payroll", fragment: "two pay cycles" }] },
  // --- multiple distant sections of one document ---
  { question: "What rent do we pay and how much is the security deposit?", category: "multi_section", expected: [{ docKey: "lease", fragment: "$8,400" }, { docKey: "lease", fragment: "$16,800" }] },
  { question: "Summarize the handbook's remote work stipend and bereavement leave.", category: "multi_section", expected: [{ docKey: "handbook-long", fragment: "$75" }, { docKey: "handbook-long", fragment: "five paid days" }] },
  { question: "What does the lease say about rent and about terminating early?", category: "multi_section", expected: [{ docKey: "lease", fragment: "$8,400" }, { docKey: "lease", fragment: "one hundred eighty days written notice" }] },
  { question: "What did the board decide about the budget and the lease renewal?", category: "multi_section", expected: [{ docKey: "minutes", fragment: "$4.2 million" }, { docKey: "minutes", fragment: "1200 Market Street" }] },
  // --- cross-document comparison ---
  { question: "Compare our monthly rent with the payment terms we give Acme.", category: "cross_document", expected: [{ docKey: "lease", fragment: "$8,400" }, { docKey: "vendor", fragment: "net thirty" }] },
  { question: "How does payroll timing compare with expense reimbursement timing?", category: "cross_document", expected: [{ docKey: "payroll", fragment: "fifteenth" }, { docKey: "payroll", fragment: "two pay cycles" }] },
  // --- unanswerable ---
  { question: "What is the office Wi-Fi password?", category: "unanswerable", expected: [], unanswerable: true },
  { question: "What is the CEO's home address?", category: "unanswerable", expected: [], unanswerable: true },
  { question: "What did the wet-ink amendment change about parking?", category: "partial_indexing", expected: [], unanswerable: true },
  // --- stale version / archived ---
  { question: "What was the rent at 800 Mission Street?", category: "stale_version", expected: [], unanswerable: true, forbidden: [{ docKey: "archive-old-lease", fragment: "$6,000" }] },
  // --- adversarial negatives: vocabulary shared with real documents, but the
  // asked-for fact is absent. A truthful retrieval returns nothing (or at
  // least nothing it should call evidence); these characterize the admission
  // rule's abstention behavior (issue #533 findings 3+7).
  { question: "What is the pet policy in the Market Street lease?", category: "unanswerable", expected: [], unanswerable: true },
  { question: "What interest rate does the IRS notice charge on unpaid balances?", category: "unanswerable", expected: [], unanswerable: true },
  { question: "What is the notice period for terminating the payroll policy?", category: "unanswerable", expected: [], unanswerable: true },
  { question: "How much did the board budget for office rent in resolution 2025-07?", category: "unanswerable", expected: [], unanswerable: true },
  { question: "What is the auto-renewal notice window in the employee handbook?", category: "unanswerable", expected: [], unanswerable: true },
  { question: "What penalty does the Acme agreement set for early termination?", category: "unanswerable", expected: [], unanswerable: true },
  // --- scope boundary ---
  { question: "What pricing change does the Notebook X strategy memo propose?", category: "scope_boundary", expected: [{ docKey: "notebook-x", fragment: "twelve percent" }] },
];

/*
 * Phrase variants turn each authored question into several draft candidates.
 * They are deliberately mechanical - the owner's manual review decides which
 * survive - but they probe exactly the paraphrase robustness the issue asks
 * about.
 */
const VARIANTS: Array<(q: string) => string> = [
  (q) => q,
  (q) => q.replace(/\?$/, "") + "? (be specific)",
  (q) => "Per our documents, " + q.charAt(0).toLowerCase() + q.slice(1),
  (q) => q.replace(/^What/, "From our files, what").replace(/^How/, "From our files, how").replace(/^When/, "From our files, when").replace(/^Which/, "From our files, which").replace(/^Summarize/, "From our files, summarize").replace(/^Compare/, "From our files, compare"),
];

export const QUESTIONS: EvalQuestion[] = BASE.flatMap((b, bi) =>
  VARIANTS.map((v, vi) => ({
    ...b,
    id: `q${String(bi * VARIANTS.length + vi + 1).padStart(3, "0")}`,
    question: v(b.question),
    split: (bi * VARIANTS.length + vi) % 10 < 7 ? "dev" : "heldout",
  })),
);
