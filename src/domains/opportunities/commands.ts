import { and, eq, isNull, sql } from "drizzle-orm";
import { recordAudit } from "@/domains/audit/record";
import { companies, contacts } from "@/domains/crm/schema";
import type { AuthContext } from "@/domains/identity/resolve";
import { withTransaction, type TxDrizzle } from "@/lib/db-transaction";
import type { OpportunityStage } from "./status";
import { opportunities, opportunitiesDeadlines, opportunityStageHistory } from "./schema";

/*
 * Opportunity mutations. A stage change is two writes that mean one thing —
 * the new stage on the record and the append-only history row — so they
 * commit in one transaction with the audit row. "Prepared" is never recorded
 * as "submitted": the stage the owner picks is the stage that is written.
 */

export class StaleWriteError extends Error {
  readonly code = "stale_write";
}

export class NotFoundError extends Error {
  readonly code = "not_found";
}

async function requireCompanyOrContact(
  auth: AuthContext,
  tx: TxDrizzle,
  input: { companyId?: string | null; primaryContactId?: string | null },
) {
  if (input.companyId) {
    const [company] = await tx
      .select({ id: companies.id })
      .from(companies)
      .where(and(eq(companies.id, input.companyId), eq(companies.workspaceId, auth.workspaceId), isNull(companies.archivedAt)))
      .limit(1);
    if (!company) throw new NotFoundError("That company is not in this workspace.");
  }
  if (input.primaryContactId) {
    const [contact] = await tx
      .select({ id: contacts.id })
      .from(contacts)
      .where(and(eq(contacts.id, input.primaryContactId), eq(contacts.workspaceId, auth.workspaceId), isNull(contacts.archivedAt)))
      .limit(1);
    if (!contact) throw new NotFoundError("That contact is not in this workspace.");
  }
}

export type OpportunityInput = {
  title: string;
  companyId?: string | null;
  primaryContactId?: string | null;
  whyItMatters?: string | null;
  sourceType?: string | null;
  nextCommitment?: string | null;
  nextCommitmentAt?: Date | null;
};

export async function createOpportunity(auth: AuthContext, input: OpportunityInput) {
  return withTransaction(async (tx) => {
    await requireCompanyOrContact(auth, tx, input);
    const [opportunity] = await tx
      .insert(opportunities)
      .values({
        workspaceId: auth.workspaceId,
        title: input.title,
        companyId: input.companyId || null,
        primaryContactId: input.primaryContactId || null,
        whyItMatters: input.whyItMatters || null,
        sourceType: input.sourceType || null,
        nextCommitment: input.nextCommitment || null,
        nextCommitmentAt: input.nextCommitmentAt ?? null,
        createdBy: auth.userId,
        updatedBy: auth.userId,
      })
      .returning();
    // The opening history row has no from-stage: it records when the record
    // entered the pipeline, so a duration in the first stage is measurable.
    await tx.insert(opportunityStageHistory).values({
      workspaceId: auth.workspaceId,
      opportunityId: opportunity.id,
      fromStage: null,
      toStage: opportunity.stage,
      note: "Created",
      changedBy: auth.userId,
    });
    await recordAudit(auth, {
      action: "opportunity.created",
      subjectType: "opportunity",
      subjectId: opportunity.id,
      summary: `Opportunity created: ${opportunity.title}`,
    }, tx);
    return opportunity;
  });
}

export async function updateOpportunity(
  auth: AuthContext,
  input: { opportunityId: string; expectedVersion: number } & OpportunityInput,
) {
  return withTransaction(async (tx) => {
    await requireCompanyOrContact(auth, tx, input);
    const [updated] = await tx
      .update(opportunities)
      .set({
        title: input.title,
        companyId: input.companyId || null,
        primaryContactId: input.primaryContactId || null,
        whyItMatters: input.whyItMatters || null,
        sourceType: input.sourceType || null,
        nextCommitment: input.nextCommitment || null,
        nextCommitmentAt: input.nextCommitmentAt ?? null,
        version: sql`${opportunities.version} + 1`,
        updatedAt: new Date(),
        updatedBy: auth.userId,
      })
      .where(
        and(
          eq(opportunities.id, input.opportunityId),
          eq(opportunities.workspaceId, auth.workspaceId),
          isNull(opportunities.archivedAt),
          eq(opportunities.version, input.expectedVersion),
        ),
      )
      .returning();
    if (!updated) {
      throw new StaleWriteError("This opportunity changed since you loaded it. Reload and try again.");
    }
    await recordAudit(auth, {
      action: "opportunity.updated",
      subjectType: "opportunity",
      subjectId: updated.id,
      summary: `Opportunity updated: ${updated.title}`,
    }, tx);
    return updated;
  });
}

export async function changeStage(
  auth: AuthContext,
  input: { opportunityId: string; expectedVersion: number; toStage: OpportunityStage; note?: string | null },
) {
  return withTransaction(async (tx) => {
    const [current] = await tx
      .select({ id: opportunities.id, stage: opportunities.stage, outcome: opportunities.outcome, title: opportunities.title })
      .from(opportunities)
      .where(
        and(
          eq(opportunities.id, input.opportunityId),
          eq(opportunities.workspaceId, auth.workspaceId),
          isNull(opportunities.archivedAt),
        ),
      )
      .limit(1);
    if (!current) throw new NotFoundError("That opportunity is not in this workspace.");
    if (current.stage === input.toStage) return { id: current.id, stage: current.stage, title: current.title, unchanged: true as const };

    // Terminal stages set the outcome once; reopening (terminal to pipeline)
    // leaves the recorded outcome for the owner to change explicitly.
    const outcome =
      current.outcome === "pending"
        ? input.toStage === "won"
          ? ("accepted" as const)
          : input.toStage === "lost"
            ? ("rejected" as const)
            : input.toStage === "withdrawn"
              ? ("declined" as const)
              : current.outcome
        : current.outcome;

    // The stage is re-checked alongside the version: the history row below
    // claims this exact from-stage, so the update must prove it won the race.
    const [updated] = await tx
      .update(opportunities)
      .set({
        stage: input.toStage,
        outcome,
        version: sql`${opportunities.version} + 1`,
        updatedAt: new Date(),
        updatedBy: auth.userId,
      })
      .where(
        and(
          eq(opportunities.id, input.opportunityId),
          eq(opportunities.workspaceId, auth.workspaceId),
          isNull(opportunities.archivedAt),
          eq(opportunities.version, input.expectedVersion),
          eq(opportunities.stage, current.stage),
        ),
      )
      .returning({ id: opportunities.id, stage: opportunities.stage, title: opportunities.title });
    if (!updated) {
      throw new StaleWriteError("This opportunity changed since you loaded it. Reload and try again.");
    }
    await tx.insert(opportunityStageHistory).values({
      workspaceId: auth.workspaceId,
      opportunityId: updated.id,
      fromStage: current.stage,
      toStage: input.toStage,
      note: input.note || null,
      changedBy: auth.userId,
    });
    await recordAudit(auth, {
      action: "opportunity.stage_changed",
      subjectType: "opportunity",
      subjectId: updated.id,
      summary: `Stage changed from ${current.stage} to ${input.toStage}: ${updated.title}`,
    }, tx);
    return { ...updated, unchanged: false as const };
  });
}

export async function archiveOpportunity(
  auth: AuthContext,
  input: { opportunityId: string; expectedVersion: number },
) {
  await withTransaction(async (tx) => {
    const [archived] = await tx
      .update(opportunities)
      .set({ archivedAt: new Date(), version: sql`${opportunities.version} + 1`, updatedAt: new Date(), updatedBy: auth.userId })
      .where(
        and(
          eq(opportunities.id, input.opportunityId),
          eq(opportunities.workspaceId, auth.workspaceId),
          isNull(opportunities.archivedAt),
          eq(opportunities.version, input.expectedVersion),
        ),
      )
      .returning({ id: opportunities.id, title: opportunities.title });
    if (!archived) {
      throw new StaleWriteError("This opportunity changed since you loaded it. Reload and try again.");
    }
    await recordAudit(auth, {
      action: "opportunity.archived",
      subjectType: "opportunity",
      subjectId: archived.id,
      summary: `Opportunity archived: ${archived.title}`,
    }, tx);
  });
}

export async function addDeadline(
  auth: AuthContext,
  input: { opportunityId: string; label: string; dueOn?: string | null },
) {
  return withTransaction(async (tx) => {
    const [opportunity] = await tx
      .select({ id: opportunities.id })
      .from(opportunities)
      .where(and(eq(opportunities.id, input.opportunityId), eq(opportunities.workspaceId, auth.workspaceId), isNull(opportunities.archivedAt)))
      .limit(1);
    if (!opportunity) throw new NotFoundError("That opportunity is not in this workspace.");
    const [deadline] = await tx
      .insert(opportunitiesDeadlines)
      .values({
        workspaceId: auth.workspaceId,
        opportunityId: opportunity.id,
        label: input.label,
        dueOn: input.dueOn || null,
        createdBy: auth.userId,
        updatedBy: auth.userId,
      })
      .returning();
    await recordAudit(auth, {
      action: "opportunity.deadline_added",
      subjectType: "opportunity",
      subjectId: opportunity.id,
      summary: `Deadline added: ${input.label}`,
    }, tx);
    return deadline;
  });
}

export async function markDeadlineMet(
  auth: AuthContext,
  input: { deadlineId: string; expectedVersion: number },
) {
  return withTransaction(async (tx) => {
    const [met] = await tx
      .update(opportunitiesDeadlines)
      .set({ metAt: new Date(), version: sql`${opportunitiesDeadlines.version} + 1`, updatedAt: new Date(), updatedBy: auth.userId })
      .where(
        and(
          eq(opportunitiesDeadlines.id, input.deadlineId),
          eq(opportunitiesDeadlines.workspaceId, auth.workspaceId),
          isNull(opportunitiesDeadlines.metAt),
          eq(opportunitiesDeadlines.version, input.expectedVersion),
        ),
      )
      .returning({ id: opportunitiesDeadlines.id, opportunityId: opportunitiesDeadlines.opportunityId, label: opportunitiesDeadlines.label });
    if (!met) {
      throw new StaleWriteError("This deadline is already met. Reload to see the current state.");
    }
    await recordAudit(auth, {
      action: "opportunity.deadline_met",
      subjectType: "opportunity",
      subjectId: met.opportunityId,
      summary: `Deadline met: ${met.label}`,
    }, tx);
    return met;
  });
}
