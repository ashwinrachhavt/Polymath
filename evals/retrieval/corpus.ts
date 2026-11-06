/*
 * DRAFT evaluation corpus for issue #533 Phase 1 (retrieval evaluation).
 * Synthetic documents only - no real user data. Every question in
 * questions.ts is a DRAFT candidate pending the owner's manual review and
 * labeling, as the issue requires ("manually reviewed questions"). The
 * corpus is sized so multi-chunk, multi-section and cross-document cases
 * actually exercise the retrieval repairs.
 */

export type CorpusDoc = {
  key: string;
  title: string;
  text: string;
  /** Simulated page spans so page mapping is exercised. */
  pageBreaks?: number[];
  /** When true, the document has no succeeded extraction (partial indexing case). */
  unindexed?: boolean;
  /** When true, the document is archived (scope-violation probe target). */
  archived?: boolean;
};

const para = (s: string, n: number) => s.repeat(n);

export const CORPUS: CorpusDoc[] = [
  {
    key: "lease",
    title: "Office Lease 1200 Market St",
    text:
      "COMMERCIAL LEASE AGREEMENT. Premises: Suite 400, 1200 Market Street, San Francisco, CA 94103. " +
      "Tenant: Northwind Traders LLC. Landlord: Market Plaza Partners. Lease reference LSE-2024-1187. " +
      "Section 3.1 Base Rent: the tenant pays monthly rent of eight thousand four hundred dollars ($8,400), due on the first day of each calendar month. " +
      para("Rent is payable by ACH transfer to the landlord's designated account without deduction or offset. ", 12) +
      "\n\nSection 7.4 Security Deposit: the landlord holds a security deposit of sixteen thousand eight hundred dollars ($16,800), equal to two months of base rent. " +
      "The deposit is returned within thirty days after surrender of the premises, less deductions for unpaid rent and damage beyond ordinary wear and tear. " +
      para("The deposit is not an advance rent payment and bears no interest unless required by law. ", 10) +
      "\n\nSection 12.2 Termination: either party may terminate at the end of year three with one hundred eighty days written notice and a termination fee equal to one month of base rent.",
  },
  {
    key: "payroll",
    title: "Payroll Policy Handbook",
    text:
      "PAYROLL POLICY. Document code HR-PAY-0042, effective January 1, 2025. " +
      "Payroll runs semi-monthly on the fifteenth and the last day of each month. " +
      para("Direct deposit is the default payment method for all employees; paper checks require written approval from the controller. ", 10) +
      "\n\nOvertime Policy: non-exempt employees earn overtime at one and a half times the regular hourly rate for hours worked beyond forty in a workweek. " +
      "California employees earn daily overtime beyond eight hours in a workday and double time beyond twelve hours. " +
      para("Overtime must be pre-approved by the employee's manager except in documented emergencies. ", 8) +
      "\n\nExpense Reimbursement: expenses are reimbursed within two pay cycles after approval in the expense system.",
  },
  {
    key: "minutes",
    title: "Board Minutes 2025-03-14",
    text:
      "MINUTES OF THE BOARD OF DIRECTORS, March 14, 2025. Quorum present: Alvarez, Chen, Okafor, Smith. " +
      "Resolution 2025-07: the board approved the annual operating budget of $4.2 million. Motion by Chen, second by Okafor; carried 4-0. " +
      para("The treasurer presented the cash flow statement and noted receivables aging improved to thirty-two days average. ", 10) +
      "\n\nResolution 2025-08: the board authorized management to negotiate a renewal of the office lease at 1200 Market Street for a term not exceeding five years. " +
      para("The governance committee was directed to review the conflict of interest policy before the June meeting. ", 8),
  },
  {
    key: "vendor",
    title: "Acme Supply MSA",
    text:
      "MASTER SERVICES AGREEMENT between Northwind Traders LLC and Acme Supply Co, contract number MSA-2023-0551. " +
      "Term: twenty-four months from the effective date, auto-renewing for successive twelve-month periods unless either party gives sixty days notice of non-renewal. " +
      para("Acme will deliver office supplies within five business days of each purchase order. ", 10) +
      "\n\nLiability Cap: each party's aggregate liability is capped at the fees paid in the twelve months preceding the claim. " +
      "Neither party is liable for indirect, incidental, or consequential damages. " +
      para("Invoices are payable net thirty from receipt; late amounts accrue interest at one percent per month. ", 8),
  },
  {
    key: "tax",
    title: "IRS Notice CP-14 2024",
    text:
      "INTERNAL REVENUE SERVICE NOTICE CP-14. Taxpayer: Northwind Traders LLC. EIN ending 4417. Tax year 2024. " +
      "Amount due: three thousand two hundred twelve dollars and forty-five cents ($3,212.45). Pay by June 2, 2025 to avoid additional interest. " +
      para("If you disagree with this notice, call the number printed above or write to the service center within sixty days. ", 10),
  },
  {
    key: "handbook-long",
    title: "Employee Handbook 2025",
    // Deliberately long: many chunks, two distant policy sections.
    text:
      "EMPLOYEE HANDBOOK. Version 2025.1, supersedes all prior versions. " +
      "Section 1.2 At-Will Employment: employment is at-will and may be terminated by either party at any time, with or without cause or notice. " +
      para("The company expects professional conduct, punctuality, and respect for colleagues in all workplaces. ", 40) +
      "\n\nSection 9.7 Remote Work Stipend: employees working remotely more than three days per week receive a monthly stipend of seventy-five dollars ($75) for internet and utilities. " +
      para("The stipend is taxable income and appears as a separate line on the payslip. ", 30) +
      "\n\nSection 14.3 Bereavement Leave: employees receive up to five paid days for the death of an immediate family member, and up to three days for other family members.",
  },
  {
    key: "scan",
    title: "Scanned Wet-Ink Amendment",
    text: "",
    unindexed: true,
  },
  {
    key: "archive-old-lease",
    title: "Old Lease 800 Mission St (superseded)",
    text:
      "COMMERCIAL LEASE. Premises: 800 Mission Street. Monthly rent of six thousand dollars ($6,000). " +
      para("This lease was terminated early by mutual agreement in December 2023. ", 8),
    archived: true,
  },
  {
    key: "notebook-x",
    title: "Notebook X Strategy Memo",
    text:
      "STRATEGY MEMO (Notebook X only). Pricing strategy: raise enterprise tier pricing by twelve percent at renewal. " +
      para("The memo also covers hiring plans for two support engineers. ", 8),
  },
];
