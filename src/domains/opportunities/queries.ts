import { and, asc, desc, eq, ilike, isNull, or, sql } from "drizzle-orm";
import { companies, contacts } from "@/domains/crm/schema";
import type { AuthContext } from "@/domains/identity/resolve";
import { db } from "@/lib/db";
import {
  opportunities,
  opportunitiesDeadlines,
  opportunityStage,
  opportunityStageHistory,
} from "./schema";

/*
 * Read queries for the opportunities pipeline. Stage is the grouping axis:
 * the page renders one column per stage from a single flat list, and the
 * detail read composes the record, its append-only stage history and its
 * deadlines in parallel.
 */

export type OpportunityStage = (typeof opportunityStage.enumValues)[number];
export const OPPORTUNITY_STAGES = opportunityStage.enumValues;

export const STAGE_LABELS: Record<OpportunityStage, string> = {
  identified: "Identified",
  researching: "Researching",
  preparing: "Preparing",
  submitted: "Submitted",
  interviewing: "Interviewing",
  negotiating: "Negotiating",
  won: "Won",
  lost: "Lost",
  withdrawn: "Withdrawn",
};

/** The stages a pipeline view shows as columns; terminal outcomes are listed, not pipelined. */
export const PIPELINE_STAGES = opportunityStage.enumValues.filter(
  (stage) => !["won", "lost", "withdrawn"].includes(stage),
);

function escapeLike(value: string) {
  return value.replace(/[%_\\]/g, (match) => `\\${match}`);
}

export type OpportunityListItem = {
  id: string;
  title: string;
  stage: OpportunityStage;
  outcome: string;
  companyName: string | null;
  primaryContactName: string | null;
  nextCommitment: string | null;
  nextCommitmentAt: Date | null;
  version: number;
  updatedAt: Date;
};

export async function listOpportunities(
  auth: AuthContext,
  input: { query?: string; stage?: OpportunityStage } = {},
): Promise<OpportunityListItem[]> {
  const filters = [eq(opportunities.workspaceId, auth.workspaceId), isNull(opportunities.archivedAt)];
  if (input.stage) filters.push(eq(opportunities.stage, input.stage));
  if (input.query?.trim()) {
    const like = `%${escapeLike(input.query.trim())}%`;
    filters.push(or(ilike(opportunities.title, like), ilike(companies.name, like))!);
  }
  return db
    .select({
      id: opportunities.id,
      title: opportunities.title,
      stage: opportunities.stage,
      outcome: opportunities.outcome,
      companyName: companies.name,
      primaryContactName: contacts.fullName,
      nextCommitment: opportunities.nextCommitment,
      nextCommitmentAt: opportunities.nextCommitmentAt,
      version: opportunities.version,
      updatedAt: opportunities.updatedAt,
    })
    .from(opportunities)
    .leftJoin(companies, and(eq(companies.id, opportunities.companyId), eq(companies.workspaceId, auth.workspaceId)))
    .leftJoin(contacts, and(eq(contacts.id, opportunities.primaryContactId), eq(contacts.workspaceId, auth.workspaceId)))
    .where(and(...filters))
    .orderBy(desc(opportunities.updatedAt))
    .limit(200);
}

export type OpportunityDetail = {
  opportunity: typeof opportunities.$inferSelect;
  companyName: string | null;
  primaryContactName: string | null;
  history: Array<typeof opportunityStageHistory.$inferSelect>;
  deadlines: Array<typeof opportunitiesDeadlines.$inferSelect>;
};

export async function getOpportunityDetail(
  auth: AuthContext,
  input: { opportunityId: string },
): Promise<OpportunityDetail | null> {
  const [row] = await db
    .select({
      opportunity: opportunities,
      companyName: companies.name,
      primaryContactName: contacts.fullName,
    })
    .from(opportunities)
    .leftJoin(companies, and(eq(companies.id, opportunities.companyId), eq(companies.workspaceId, auth.workspaceId)))
    .leftJoin(contacts, and(eq(contacts.id, opportunities.primaryContactId), eq(contacts.workspaceId, auth.workspaceId)))
    .where(
      and(
        eq(opportunities.id, input.opportunityId),
        eq(opportunities.workspaceId, auth.workspaceId),
        isNull(opportunities.archivedAt),
      ),
    )
    .limit(1);
  if (!row) return null;

  const [history, deadlines] = await Promise.all([
    db
      .select()
      .from(opportunityStageHistory)
      .where(
        and(
          eq(opportunityStageHistory.opportunityId, row.opportunity.id),
          eq(opportunityStageHistory.workspaceId, auth.workspaceId),
        ),
      )
      .orderBy(desc(opportunityStageHistory.createdAt))
      .limit(100),
    db
      .select()
      .from(opportunitiesDeadlines)
      .where(
        and(
          eq(opportunitiesDeadlines.opportunityId, row.opportunity.id),
          eq(opportunitiesDeadlines.workspaceId, auth.workspaceId),
        ),
      )
      .orderBy(asc(opportunitiesDeadlines.dueOn))
      .limit(50),
  ]);

  return { ...row, history, deadlines };
}
