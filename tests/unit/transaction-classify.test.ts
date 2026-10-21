import { describe, expect, it } from "vitest";
import {
  classifyTransaction,
  classifyTransactions,
  merchantKey,
  summarize,
} from "@/domains/knowledge/transaction-classify";
import { buildClassifiedLedgerCsv } from "@/domains/knowledge/statement-csv";
import type { StatementTransaction } from "@/domains/knowledge/statement-import";

/*
 * Value: protects=a transaction is never given a confident category the
 * evidence does not support: unsure rows go to review, owner corrections win,
 * direction rules out nonsense (a salary cannot be money out);
 * fails_when=an unknown merchant is auto-categorised, a correction is ignored,
 * or the distribution stops summing to one; why_new=no classifier existed;
 * seam=classifyTransaction, pure, local; no_claim=accuracy on real statements
 * (descriptions here are synthetic), and no hosted model is ever called.
 */

const out = (description: string) => classifyTransaction({ description, amount: "-25.00" });
const into = (description: string) => classifyTransaction({ description, amount: "25.00" });

describe("classifyTransaction", () => {
  it.each([
    ["POS 4411 STARBUCKS COFFEE SEATTLE", "dining"],
    ["UPI/412345678901/BIGBASKET/okaxis", "groceries"],
    ["Netflix.com subscription", "subscriptions"],
    ["ACH D RENT - OAK STREET LANDLORD", "housing"],
    ["Uber trip help.uber.com", "transport"],
    ["HDFC CARD EMI 3 of 12", "loan_emi"],
    ["ATM CASH WDL 0042", "cash"],
    ["Monthly maintenance fee", "fees_interest"],
  ] as const)("routes %s to %s without review", (description, category) => {
    const judgment = out(description);
    expect(judgment.category).toBe(category);
    expect(judgment.route).toBe("auto");
    expect(judgment.evidence.length).toBeGreaterThan(0);
  });

  it("uses direction: salary is money in, rent is money out", () => {
    expect(into("PAYROLL ACME CORP SALARY").category).toBe("income_salary");
    expect(out("PAYROLL ACME CORP SALARY").category).not.toBe("income_salary");
    expect(into("Refund for order 1182").category).toBe("refund");
  });

  it("sends an unknown merchant to review instead of guessing", () => {
    const judgment = out("QWZX 88 TRADING CO");
    expect(judgment.category).toBe("unknown");
    expect(judgment.route).toBe("review");
    expect(judgment.confidence).toBe(0);
  });

  it("sends a bare UPI payment to review: the rail says nothing about the purpose", () => {
    const judgment = out("UPI/998877665544/r.kumar@okhdfc");
    expect(judgment.route).toBe("review");
  });

  it("returns a distribution that sums to one", () => {
    const judgment = out("Amazon Prime subscription");
    const sum = Object.values(judgment.distribution).reduce((a, b) => a + b, 0);
    expect(sum).toBeGreaterThan(0.99);
    expect(sum).toBeLessThan(1.01);
    expect(judgment.category).toBe("subscriptions");
  });

  it("lets an owner correction win with full confidence, and keys it by merchant not reference", () => {
    const key = merchantKey("UPI/412345678901/QWZX TRADING/okaxis");
    expect(key).toBe(merchantKey("UPI/555500001111/QWZX TRADING/okaxis"));
    const judgment = classifyTransaction(
      { description: "UPI/555500001111/QWZX TRADING/okaxis", amount: "-90.00" },
      { ownerRules: [{ merchantKey: key, category: "education" }] },
    );
    expect(judgment).toMatchObject({ category: "education", confidence: 1, source: "owner_rule", route: "auto" });
  });

  it("honours stricter gate settings", () => {
    const loose = classifyTransaction({ description: "NEFT transfer", amount: "-10.00" });
    const strict = classifyTransaction({ description: "NEFT transfer", amount: "-10.00" }, { minConfidence: 0.95 });
    expect(loose.route).toBe("auto");
    expect(strict.route).toBe("review");
  });
});

describe("summaries and export", () => {
  const rows = [
    { description: "Starbucks coffee", amount: "-6.50" },
    { description: "PAYROLL SALARY", amount: "3000.00" },
    { description: "QWZX 88 TRADING", amount: "-12.00" },
  ];

  it("summarizes spend by category and counts review rows", () => {
    const summary = summarize(rows, classifyTransactions(rows));
    expect(summary).toMatchObject({ total: 3, auto: 2, review: 1 });
    expect(summary.byCategory.dining).toEqual({ count: 1, spent: "6.50", received: "0.00" });
    expect(summary.byCategory.income_salary?.received).toBe("3000.00");
  });

  it("adds category columns to the CSV and flags unsure rows", () => {
    const transactions = rows.map((row, index) => ({
      id: "x", workspaceId: "x", importId: "x", accountLabel: "A", occurredOn: "2026-08-0" + (index + 1),
      description: row.description, rawDescription: row.description, amount: row.amount, balanceAfter: null,
      position: index, createdAt: new Date(0),
    })) as StatementTransaction[];
    const csv = buildClassifiedLedgerCsv(transactions);
    const lines = csv.replace(/^\ufeff/, "").trim().split("\r\n");
    expect(lines[0]).toBe("Date,Description,Amount,Category,Confidence,Needs review");
    expect(lines[1]).toMatch(/,-6\.50,dining,0\.\d\d,no$/);
    expect(lines[3]).toMatch(/,-12\.00,unknown,0\.00,yes$/);
  });
});
