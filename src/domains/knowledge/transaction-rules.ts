import { and, eq, isNull } from "drizzle-orm";
import type { AuthContext } from "@/domains/identity/resolve";
import { db } from "@/lib/db";
import { statementImports, statementTransactions, transactionCategoryRules } from "./statement-schema";
import {
  CATEGORY_CRITERIA,
  classifyTransactions,
  merchantKey,
  type Category,
  type Judgment,
  type OwnerRule,
} from "./transaction-classify";

/*
 * Owner corrections for transaction categories. The classifier is pure; this is
 * the only place that touches the database. Every read and write is scoped to
 * the caller's workspace, and a correction is keyed by the merchant the
 * transaction belongs to, never by a client-supplied key.
 */

export class TransactionNotFoundError extends Error {
  constructor() {
    super("No such transaction in this workspace.");
    this.name = "TransactionNotFoundError";
  }
}

export class UnknownCategoryError extends Error {
  constructor(readonly category: string) {
    super(`"${category}" is not a category.`);
    this.name = "UnknownCategoryError";
  }
}

export function isCategory(value: string): value is Category {
  return Object.prototype.hasOwnProperty.call(CATEGORY_CRITERIA, value);
}

export async function listOwnerRules(auth: AuthContext): Promise<OwnerRule[]> {
  const rows = await db
    .select({ merchantKey: transactionCategoryRules.merchantKey, category: transactionCategoryRules.category })
    .from(transactionCategoryRules)
    .where(
      and(
        eq(transactionCategoryRules.workspaceId, auth.workspaceId),
        isNull(transactionCategoryRules.archivedAt),
      ),
    );
  return rows.filter((row): row is OwnerRule => isCategory(row.category));
}

/** Judgments for stored transactions, applying the workspace's corrections. */
export async function judgeTransactions(
  auth: AuthContext,
  transactions: Array<{ description: string; amount: string }>,
): Promise<Judgment[]> {
  return classifyTransactions(transactions, { ownerRules: await listOwnerRules(auth) });
}

/**
 * Remember that this transaction's merchant belongs to `category`. Returns the
 * key stored, so the caller can tell the owner what the correction will cover.
 */
export async function setTransactionCategory(
  auth: AuthContext,
  transactionId: string,
  category: string,
): Promise<{ merchantKey: string; category: Category }> {
  if (!isCategory(category)) throw new UnknownCategoryError(category);
  const [transaction] = await db
    .select({ description: statementTransactions.description })
    .from(statementTransactions)
    .innerJoin(statementImports, eq(statementImports.id, statementTransactions.importId))
    .where(
      and(
        eq(statementTransactions.id, transactionId),
        eq(statementTransactions.workspaceId, auth.workspaceId),
        eq(statementImports.workspaceId, auth.workspaceId),
      ),
    )
    .limit(1);
  if (!transaction) throw new TransactionNotFoundError();

  const key = merchantKey(transaction.description);
  if (!key) throw new TransactionNotFoundError();

  await db
    .insert(transactionCategoryRules)
    .values({
      workspaceId: auth.workspaceId,
      merchantKey: key,
      category,
      createdBy: auth.userId,
      updatedBy: auth.userId,
    })
    .onConflictDoUpdate({
      target: [transactionCategoryRules.workspaceId, transactionCategoryRules.merchantKey],
      set: { category, updatedBy: auth.userId, updatedAt: new Date(), archivedAt: null },
    });
  return { merchantKey: key, category };
}
