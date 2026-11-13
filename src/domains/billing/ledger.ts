import { and, eq, gte, ne, sql } from "drizzle-orm";
import { priceCall } from "@/domains/agents/models";
import { db } from "@/lib/db";
import { currentWeek, getPlan, weeklyAllowance } from "./plans";
import { modelUsageLedger, type KeySource, type Plan, type UsagePurpose } from "./schema";

/*
 * The usage ledger: one append-only row per model call, whoever's key served
 * it. This is both the record Spending reads and the evidence the weekly
 * allowance is derived from (house-keyed calls this week). Embeddings are
 * recorded but never counted: capture and search must keep working on the free
 * plan.
 */

export type ModelCall = {
  workspaceId: string;
  purpose: UsagePurpose;
  provider: string;
  model: string;
  keySource: KeySource;
  /** Absent when the provider reported no usage: the row then carries no price rather than a false zero. */
  inputTokens?: number;
  outputTokens?: number;
  /** Overrides the catalog price (embedding models are not in the catalog). */
  costUsd?: number | null;
  runId?: string;
  /** Idempotency key: recording the same ref twice writes one row. */
  sourceRef?: string;
};

export async function recordModelCall(call: ModelCall): Promise<void> {
  const known = call.inputTokens !== undefined || call.outputTokens !== undefined;
  const cost =
    call.costUsd !== undefined
      ? call.costUsd
      : known
        ? priceCall(call.model, call.inputTokens ?? 0, call.outputTokens ?? 0)
        : null;
  await db
    .insert(modelUsageLedger)
    .values({
      workspaceId: call.workspaceId,
      purpose: call.purpose,
      provider: call.provider,
      model: call.model,
      keySource: call.keySource,
      inputTokens: call.inputTokens ?? 0,
      outputTokens: call.outputTokens ?? 0,
      costUsd: cost === null ? null : cost.toFixed(8),
      runId: call.runId ?? null,
      sourceRef: call.sourceRef ?? null,
    })
    .onConflictDoNothing();
}

export async function houseCallsThisWeek(workspaceId: string, now: Date = new Date()): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(modelUsageLedger)
    .where(
      and(
        eq(modelUsageLedger.workspaceId, workspaceId),
        eq(modelUsageLedger.keySource, "house"),
        ne(modelUsageLedger.purpose, "embedding"),
        gte(modelUsageLedger.createdAt, currentWeek(now).start),
      ),
    );
  return row?.count ?? 0;
}

export type AllowanceStatus = { plan: Plan; used: number; allowance: number; resetsAt: Date };

export async function allowanceStatus(workspaceId: string, now: Date = new Date()): Promise<AllowanceStatus> {
  const plan = await getPlan(workspaceId);
  return {
    plan,
    used: await houseCallsThisWeek(workspaceId, now),
    allowance: weeklyAllowance(plan),
    resetsAt: currentWeek(now).resetsAt,
  };
}
