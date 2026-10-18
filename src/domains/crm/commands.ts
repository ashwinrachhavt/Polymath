import { and, eq, isNull, sql } from "drizzle-orm";
import type { AuthContext } from "@/domains/identity/resolve";
import { recordAudit } from "@/domains/audit/record";
import { withTransaction, type TxDrizzle } from "@/lib/db-transaction";
import type { RelationshipStatus } from "./queries";
import {
  companies,
  contactCompanies,
  contactObservations,
  contacts,
  followUps,
} from "./schema";

/*
 * CRM mutations. The database guards carry the concurrency story: the email
 * and domain partial unique indexes turn a duplicate into a ConflictError,
 * and every update re-checks `version` in its WHERE clause so a stale client
 * cannot silently overwrite a newer read. Audit rows commit in the same
 * transaction as the change they describe.
 */

/** A uniqueness guard fired — the message is safe to show the owner. */
export class ConflictError extends Error {
  readonly code = "conflict";
}

/** The row changed since the caller loaded it; reload and retry. */
export class StaleWriteError extends Error {
  readonly code = "stale_write";
}

export class NotFoundError extends Error {
  readonly code = "not_found";
}

function isUniqueViolation(cause: unknown): boolean {
  return (cause as { cause?: { code?: string } })?.cause?.code === "23505";
}

export type ContactInput = {
  fullName: string;
  primaryEmail?: string | null;
  phone?: string | null;
  title?: string | null;
  location?: string | null;
  relationshipStatus?: RelationshipStatus;
  notes?: string | null;
  companyId?: string | null;
};

export async function createContact(auth: AuthContext, input: ContactInput) {
  try {
    return await withTransaction(async (tx) => {
      if (input.companyId) await requireCompany(auth, input.companyId, tx);
      const [contact] = await tx
        .insert(contacts)
        .values({
          workspaceId: auth.workspaceId,
          fullName: input.fullName,
          primaryEmail: input.primaryEmail || null,
          phone: input.phone || null,
          title: input.title || null,
          location: input.location || null,
          relationshipStatus: input.relationshipStatus ?? "unknown",
          notes: input.notes || null,
          createdBy: auth.userId,
          updatedBy: auth.userId,
        })
        .returning();
      if (input.companyId) {
        await tx.insert(contactCompanies).values({
          workspaceId: auth.workspaceId,
          contactId: contact.id,
          companyId: input.companyId,
          title: input.title || null,
          isCurrent: true,
        });
      }
      await recordAudit(auth, {
        action: "contact.created",
        subjectType: "contact",
        subjectId: contact.id,
        summary: `Contact created: ${contact.fullName}`,
      }, tx);
      return contact;
    });
  } catch (cause) {
    if (isUniqueViolation(cause)) {
      throw new ConflictError("A contact with this email already exists.");
    }
    throw cause;
  }
}

async function requireCompany(auth: AuthContext, companyId: string, tx: TxDrizzle) {
  const [company] = await tx
    .select({ id: companies.id })
    .from(companies)
    .where(
      and(
        eq(companies.id, companyId),
        eq(companies.workspaceId, auth.workspaceId),
        isNull(companies.archivedAt),
      ),
    )
    .limit(1);
  if (!company) throw new NotFoundError("That company is not in this workspace.");
}

export async function updateContact(
  auth: AuthContext,
  input: { contactId: string; expectedVersion: number } & ContactInput,
) {
  try {
    return await withTransaction(async (tx) => {
      if (input.companyId) await requireCompany(auth, input.companyId, tx);
      const [updated] = await tx
        .update(contacts)
        .set({
          fullName: input.fullName,
          primaryEmail: input.primaryEmail || null,
          phone: input.phone || null,
          title: input.title || null,
          location: input.location || null,
          relationshipStatus: input.relationshipStatus ?? "unknown",
          notes: input.notes || null,
          version: sql`${contacts.version} + 1`,
          updatedAt: new Date(),
          updatedBy: auth.userId,
        })
        .where(
          and(
            eq(contacts.id, input.contactId),
            eq(contacts.workspaceId, auth.workspaceId),
            isNull(contacts.archivedAt),
            eq(contacts.version, input.expectedVersion),
          ),
        )
        .returning();
      if (!updated) {
        throw new StaleWriteError("This contact changed since you loaded it. Reload and try again.");
      }
      // A company change ends the current edge and opens a new one; history is
      // kept because a job change is a new fact, not an overwrite. A save that
      // keeps the same company leaves the edges alone.
      if (input.companyId !== undefined) {
        const [current] = await tx
          .select({ companyId: contactCompanies.companyId })
          .from(contactCompanies)
          .where(
            and(
              eq(contactCompanies.contactId, updated.id),
              eq(contactCompanies.workspaceId, auth.workspaceId),
              eq(contactCompanies.isCurrent, true),
            ),
          )
          .limit(1);
        const currentId = current?.companyId ?? null;
        if (currentId !== (input.companyId || null)) {
          await tx
            .update(contactCompanies)
            .set({ isCurrent: false, endedAt: new Date() })
            .where(
              and(
                eq(contactCompanies.contactId, updated.id),
                eq(contactCompanies.workspaceId, auth.workspaceId),
                eq(contactCompanies.isCurrent, true),
              ),
            );
          if (input.companyId) {
            await tx.insert(contactCompanies).values({
              workspaceId: auth.workspaceId,
              contactId: updated.id,
              companyId: input.companyId,
              title: input.title || null,
              isCurrent: true,
            });
          }
        }
      }
      await recordAudit(auth, {
        action: "contact.updated",
        subjectType: "contact",
        subjectId: updated.id,
        summary: `Contact updated: ${updated.fullName}`,
      }, tx);
      return updated;
    });
  } catch (cause) {
    if (isUniqueViolation(cause)) {
      throw new ConflictError("A contact with this email already exists.");
    }
    throw cause;
  }
}

/** Soft delete: the record stays so linked history (documents, follow-ups) keeps its referent. */
export async function archiveContact(
  auth: AuthContext,
  input: { contactId: string; expectedVersion: number },
) {
  await withTransaction(async (tx) => {
    const [archived] = await tx
      .update(contacts)
      .set({
        archivedAt: new Date(),
        version: sql`${contacts.version} + 1`,
        updatedAt: new Date(),
        updatedBy: auth.userId,
      })
      .where(
        and(
          eq(contacts.id, input.contactId),
          eq(contacts.workspaceId, auth.workspaceId),
          isNull(contacts.archivedAt),
          eq(contacts.version, input.expectedVersion),
        ),
      )
      .returning({ id: contacts.id, fullName: contacts.fullName });
    if (!archived) {
      throw new StaleWriteError("This contact changed since you loaded it. Reload and try again.");
    }
    await recordAudit(auth, {
      action: "contact.archived",
      subjectType: "contact",
      subjectId: archived.id,
      summary: `Contact archived: ${archived.fullName}`,
    }, tx);
  });
}

export async function addObservation(
  auth: AuthContext,
  input: { contactId: string; body: string; source: "stated" | "document" | "observed" },
) {
  return withTransaction(async (tx) => {
    const [contact] = await tx
      .select({ id: contacts.id })
      .from(contacts)
      .where(
        and(
          eq(contacts.id, input.contactId),
          eq(contacts.workspaceId, auth.workspaceId),
          isNull(contacts.archivedAt),
        ),
      )
      .limit(1);
    if (!contact) throw new NotFoundError("That contact is not in this workspace.");
    const [observation] = await tx
      .insert(contactObservations)
      .values({
        workspaceId: auth.workspaceId,
        contactId: contact.id,
        body: input.body,
        source: input.source,
        createdBy: auth.userId,
        updatedBy: auth.userId,
      })
      .returning();
    await recordAudit(auth, {
      action: "contact.observation_added",
      subjectType: "contact",
      subjectId: contact.id,
      summary: `Observation added (${input.source})`,
    }, tx);
    return observation;
  });
}

export async function createFollowUp(
  auth: AuthContext,
  input: { contactId: string; dueAt?: Date | null; note?: string | null },
) {
  return withTransaction(async (tx) => {
    const [contact] = await tx
      .select({ id: contacts.id, fullName: contacts.fullName })
      .from(contacts)
      .where(
        and(
          eq(contacts.id, input.contactId),
          eq(contacts.workspaceId, auth.workspaceId),
          isNull(contacts.archivedAt),
        ),
      )
      .limit(1);
    if (!contact) throw new NotFoundError("That contact is not in this workspace.");
    const [followUp] = await tx
      .insert(followUps)
      .values({
        workspaceId: auth.workspaceId,
        contactId: contact.id,
        dueAt: input.dueAt ?? null,
        note: input.note || null,
        createdBy: auth.userId,
        updatedBy: auth.userId,
      })
      .returning();
    await recordAudit(auth, {
      action: "follow_up.created",
      subjectType: "contact",
      subjectId: contact.id,
      summary: `Follow-up created for ${contact.fullName}`,
    }, tx);
    return followUp;
  });
}

export async function resolveFollowUp(
  auth: AuthContext,
  input: { followUpId: string; expectedVersion: number; resolution: "done" | "cancelled" },
) {
  await withTransaction(async (tx) => {
    const [resolved] = await tx
      .update(followUps)
      .set({
        status: input.resolution,
        resolvedAt: new Date(),
        version: sql`${followUps.version} + 1`,
        updatedAt: new Date(),
        updatedBy: auth.userId,
      })
      .where(
        and(
          eq(followUps.id, input.followUpId),
          eq(followUps.workspaceId, auth.workspaceId),
          eq(followUps.status, "open"),
          eq(followUps.version, input.expectedVersion),
        ),
      )
      .returning({ id: followUps.id });
    if (!resolved) {
      throw new StaleWriteError("This follow-up is no longer open. Reload to see the current state.");
    }
    await recordAudit(auth, {
      action: `follow_up.${input.resolution}`,
      subjectType: "follow_up",
      subjectId: resolved.id,
      summary: `Follow-up ${input.resolution}`,
    }, tx);
  });
}

export async function createCompany(
  auth: AuthContext,
  input: { name: string; domain?: string | null; description?: string | null },
) {
  try {
    return await withTransaction(async (tx) => {
      const [company] = await tx
        .insert(companies)
        .values({
          workspaceId: auth.workspaceId,
          name: input.name,
          domain: input.domain || null,
          description: input.description || null,
          createdBy: auth.userId,
          updatedBy: auth.userId,
        })
        .returning();
      await recordAudit(auth, {
        action: "company.created",
        subjectType: "company",
        subjectId: company.id,
        summary: `Company created: ${company.name}`,
      }, tx);
      return company;
    });
  } catch (cause) {
    if (isUniqueViolation(cause)) {
      throw new ConflictError("A company with this domain already exists.");
    }
    throw cause;
  }
}
