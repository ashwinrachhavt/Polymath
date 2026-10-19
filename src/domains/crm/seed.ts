import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "@/domains/audit/record";
import type { AuthContext } from "@/domains/identity/resolve";
import { db } from "@/lib/db";
import { withTransaction, type TxDrizzle } from "@/lib/db-transaction";
import { calendars, eventAttendees, eventLinks, events } from "@/domains/calendar/schema";
import { opportunities } from "@/domains/opportunities/schema";
import { companies, contactCompanies, contactObservations, contacts } from "./schema";

/*
 * Personal company and calendar seeding: the owner's own evidence inventory,
 * not synthetic demo data. It writes the CRM tables the Relationships and
 * Opportunities screens read, plus the calendar events that justified each
 * relationship.
 *
 * The rules the shape enforces:
 *   - A scheduled meeting proves a scheduled meeting. It never proves
 *     attendance, employment, an offer, or an active application; stage and
 *     relationship status stay the owner's assertions.
 *   - An email domain is observed evidence, not an automatic merger. A domain
 *     that a parent, an ATS, or a second company might own is recorded as an
 *     attribute and never claimed as the company's `domain`.
 *   - Absent facts stay null. No invented surnames, titles, websites, or
 *     timestamps.
 *   - Nothing is deleted or overwritten. A re-run matches and reports; fields
 *     the owner has since edited are left alone.
 */

const nameStatus = z.enum(["explicit_source", "domain_inferred"]);

export const personalSeedSchema = z.object({
  snapshotDate: z.string().date(),
  timezone: z.string().min(1),
  note: z.string().optional(),
  companies: z.array(
    z.object({
      name: z.string().min(1),
      nameStatus,
      domains: z.array(z.string()).default([]),
      categories: z.array(z.string()).default([]),
      summary: z.string().nullable().default(null),
      unresolved: z.string().nullable().optional(),
    }),
  ),
  contacts: z.array(
    z.object({
      name: z.string().min(1),
      email: z.string().email().nullable().default(null),
      company: z.string().min(1).nullable().default(null),
      title: z.string().nullable().default(null),
      note: z.string().nullable().default(null),
    }),
  ),
  interactions: z.array(
    z.object({
      company: z.string().min(1),
      contactEmails: z.array(z.string().email()).default([]),
      title: z.string().min(1),
      kind: z.enum([
        "interview",
        "recruiter_screen",
        "introduction",
        "professional_services_call",
        "general_meeting",
        "canceled_meeting",
      ]),
      status: z.enum(["confirmed", "tentative", "cancelled"]).default("confirmed"),
      /** Local wall-clock in `timezone`, no offset. Converted on write. */
      startsAt: z.string().min(16),
      endsAt: z.string().min(16),
    }),
  ),
  opportunities: z
    .array(
      z.object({
        company: z.string().min(1),
        title: z.string().min(1),
        stage: z.enum([
          "identified",
          "researching",
          "preparing",
          "submitted",
          "interviewing",
          "negotiating",
          "won",
          "lost",
          "withdrawn",
        ]),
        primaryContactEmail: z.string().email().nullable().default(null),
      }),
    )
    .default([]),
});

export type PersonalSeed = z.infer<typeof personalSeedSchema>;

export type SeedSummary = {
  applied: boolean;
  companies: { created: number; matched: number };
  contacts: { created: number; matched: number };
  employments: { created: number };
  events: { created: number; matched: number; cancelled: number };
  attendees: { created: number };
  opportunities: { created: number; matched: number };
  unresolved: string[];
};

class DryRunRollback extends Error {}

/**
 * One transaction. In dry-run the transaction is rolled back on purpose, so
 * the plan is computed by the same code that would write it and a partial
 * write is impossible either way.
 */
export async function seedPersonalData(
  auth: AuthContext,
  raw: unknown,
  options: { apply: boolean },
): Promise<SeedSummary> {
  const dataset = personalSeedSchema.parse(raw);
  const summary: SeedSummary = {
    applied: options.apply,
    companies: { created: 0, matched: 0 },
    contacts: { created: 0, matched: 0 },
    employments: { created: 0 },
    events: { created: 0, matched: 0, cancelled: 0 },
    attendees: { created: 0 },
    opportunities: { created: 0, matched: 0 },
    unresolved: dataset.companies.flatMap((company) =>
      company.unresolved ? [`${company.name}: ${company.unresolved}`] : [],
    ),
  };

  try {
    await withTransaction(async (tx) => {
      const companyIds = await upsertCompanies(auth, tx, dataset, summary);
      const contactIds = await upsertContacts(auth, tx, dataset, companyIds, summary);
      await upsertEvents(auth, tx, dataset, companyIds, contactIds, summary);
      await upsertOpportunities(auth, tx, dataset, companyIds, contactIds, summary);

      if (!options.apply) throw new DryRunRollback();

      const changed =
        summary.companies.created +
        summary.contacts.created +
        summary.employments.created +
        summary.events.created +
        summary.opportunities.created;
      if (changed > 0) {
        await recordAudit(
          auth,
          {
            action: "personal_seed.imported",
            subjectType: "workspace",
            subjectId: auth.workspaceId,
            summary: `Personal seed applied (${dataset.snapshotDate})`,
            metadata: {
              snapshotDate: dataset.snapshotDate,
              companiesCreated: summary.companies.created,
              contactsCreated: summary.contacts.created,
              eventsCreated: summary.events.created,
              opportunitiesCreated: summary.opportunities.created,
            },
          },
          tx,
        );
      }
    });
  } catch (error) {
    if (!(error instanceof DryRunRollback)) throw error;
  }

  return summary;
}

type CompanyIds = Map<string, string>;
type ContactIds = Map<string, string>;

function key(value: string) {
  return value.trim().toLowerCase();
}

async function upsertCompanies(
  auth: AuthContext,
  tx: TxDrizzle,
  dataset: PersonalSeed,
  summary: SeedSummary,
): Promise<CompanyIds> {
  const existing = await tx
    .select({ id: companies.id, name: companies.name, domain: companies.domain, description: companies.description })
    .from(companies)
    .where(and(eq(companies.workspaceId, auth.workspaceId), isNull(companies.archivedAt)));

  const byName = new Map(existing.map((row) => [key(row.name), row]));
  // The domain index is unique per workspace, so a domain already owned by
  // another org is recorded as evidence but never claimed.
  const claimedDomains = new Set(existing.map((row) => row.domain).filter((d): d is string => !!d));
  const ids: CompanyIds = new Map();

  for (const company of dataset.companies) {
    const match = byName.get(key(company.name));
    if (match) {
      ids.set(company.name, match.id);
      summary.companies.matched += 1;
      // Fill only what is empty; an owner edit is evidence too.
      if (!match.description && company.summary) {
        await tx.update(companies).set({ description: company.summary }).where(eq(companies.id, match.id));
      }
      continue;
    }

    const claimable = company.domains.find((domain) => !claimedDomains.has(key(domain))) ?? null;
    const attributes = [
      { label: "name_status", value: company.nameStatus },
      { label: "observed_domains", value: company.domains.join(", ") },
      ...(company.unresolved ? [{ label: "unresolved", value: company.unresolved }] : []),
    ];
    const [created] = await tx
      .insert(companies)
      .values({
        workspaceId: auth.workspaceId,
        name: company.name,
        domain: claimable,
        description: company.summary,
        attributes,
        tags: ["personal_seed", ...company.categories],
        createdBy: auth.userId,
        updatedBy: auth.userId,
      })
      .returning({ id: companies.id });
    ids.set(company.name, created.id);
    byName.set(key(company.name), { id: created.id, name: company.name, domain: claimable, description: company.summary });
    if (claimable) claimedDomains.add(key(claimable));
    summary.companies.created += 1;
  }

  return ids;
}

async function upsertContacts(
  auth: AuthContext,
  tx: TxDrizzle,
  dataset: PersonalSeed,
  companyIds: CompanyIds,
  summary: SeedSummary,
): Promise<ContactIds> {
  const existing = await tx
    .select({
      id: contacts.id,
      fullName: contacts.fullName,
      primaryEmail: contacts.primaryEmail,
      title: contacts.title,
      notes: contacts.notes,
      companyName: companies.name,
    })
    .from(contacts)
    .leftJoin(
      contactCompanies,
      and(
        eq(contactCompanies.contactId, contacts.id),
        eq(contactCompanies.workspaceId, contacts.workspaceId),
        eq(contactCompanies.isCurrent, true),
      ),
    )
    .leftJoin(companies, eq(companies.id, contactCompanies.companyId))
    .where(and(eq(contacts.workspaceId, auth.workspaceId), isNull(contacts.archivedAt)));

  const byEmail = new Map(
    existing.filter((row) => row.primaryEmail).map((row) => [key(row.primaryEmail!), row]),
  );
  // A name alone never merges: two people called Chris at two companies stay
  // two people. Name plus current company is the idempotency key for a contact
  // the evidence gives no address for.
  const byNameAndCompany = new Map(existing.map((row) => [`${key(row.fullName)}|${key(row.companyName ?? "")}`, row]));
  const ids: ContactIds = new Map();

  for (const contact of dataset.contacts) {
    const match = contact.email
      ? byEmail.get(key(contact.email))
      : byNameAndCompany.get(`${key(contact.name)}|${key(contact.company ?? "")}`);
    let contactId: string;

    if (match) {
      contactId = match.id;
      summary.contacts.matched += 1;
      const patch: Partial<typeof contacts.$inferInsert> = {};
      if (!match.title && contact.title) patch.title = contact.title;
      if (!match.notes && contact.note) patch.notes = contact.note;
      if (Object.keys(patch).length) {
        await tx.update(contacts).set(patch).where(eq(contacts.id, contactId));
      }
    } else {
      const [created] = await tx
        .insert(contacts)
        .values({
          workspaceId: auth.workspaceId,
          fullName: contact.name,
          primaryEmail: contact.email,
          title: contact.title,
          relationshipStatus: "active",
          notes: contact.note,
          tags: ["personal_seed"],
          createdBy: auth.userId,
          updatedBy: auth.userId,
        })
        .returning({ id: contacts.id });
      contactId = created.id;
      const inserted = {
        id: created.id,
        fullName: contact.name,
        primaryEmail: contact.email,
        title: contact.title,
        notes: contact.note,
        companyName: contact.company,
      };
      byNameAndCompany.set(`${key(contact.name)}|${key(contact.company ?? "")}`, inserted);
      if (contact.email) byEmail.set(key(contact.email), inserted);
      summary.contacts.created += 1;
    }

    if (!contact.email) ids.set(key(`name:${contact.name}`), contactId);
    else ids.set(key(contact.email), contactId);

    if (contact.note) {
      // Provenance rides on every assertion; only one row per contact per note.
      const [already] = await tx
        .select({ id: contactObservations.id })
        .from(contactObservations)
        .where(
          and(
            eq(contactObservations.workspaceId, auth.workspaceId),
            eq(contactObservations.contactId, contactId),
            eq(contactObservations.body, contact.note),
          ),
        )
        .limit(1);
      if (!already) {
        await tx.insert(contactObservations).values({
          workspaceId: auth.workspaceId,
          contactId,
          body: contact.note,
          source: "observed",
          evidenceType: "personal_seed",
          createdBy: auth.userId,
          updatedBy: auth.userId,
        });
      }
    }

    const companyId = contact.company ? companyIds.get(contact.company) : null;
    if (!companyId) continue;
    const [edge] = await tx
      .select({ id: contactCompanies.id })
      .from(contactCompanies)
      .where(
        and(
          eq(contactCompanies.workspaceId, auth.workspaceId),
          eq(contactCompanies.contactId, contactId),
          eq(contactCompanies.companyId, companyId),
        ),
      )
      .limit(1);
    if (!edge) {
      await tx.insert(contactCompanies).values({
        workspaceId: auth.workspaceId,
        contactId,
        companyId,
        title: contact.title,
        isCurrent: true,
      });
      summary.employments.created += 1;
    }
  }

  return ids;
}

async function upsertEvents(
  auth: AuthContext,
  tx: TxDrizzle,
  dataset: PersonalSeed,
  companyIds: CompanyIds,
  contactIds: ContactIds,
  summary: SeedSummary,
) {
  const [existingCalendar] = await tx
    .select({ id: calendars.id })
    .from(calendars)
    .where(and(eq(calendars.workspaceId, auth.workspaceId), eq(calendars.name, "Personal")))
    .limit(1);

  let calendarId = existingCalendar?.id;
  if (!calendarId) {
    const [created] = await tx
      .insert(calendars)
      .values({
        workspaceId: auth.workspaceId,
        kind: "local",
        name: "Personal",
        timezone: dataset.timezone,
        isPrimary: true,
        createdBy: auth.userId,
        updatedBy: auth.userId,
      })
      .returning({ id: calendars.id });
    calendarId = created.id;
  }

  for (const interaction of dataset.interactions) {
    const companyId = companyIds.get(interaction.company);
    if (!companyId) continue;
    const startsAt = zonedToUtc(interaction.startsAt, dataset.timezone);
    const endsAt = zonedToUtc(interaction.endsAt, dataset.timezone);

    // Local events carry no provider id, so identity is the title plus the
    // exact start: a re-run matches, and two genuine rounds stay two rows.
    const [match] = await tx
      .select({ id: events.id })
      .from(events)
      .where(
        and(
          eq(events.workspaceId, auth.workspaceId),
          eq(events.title, interaction.title),
          eq(events.startsAt, startsAt),
        ),
      )
      .limit(1);

    let eventId = match?.id;
    if (eventId) {
      summary.events.matched += 1;
    } else {
      const [created] = await tx
        .insert(events)
        .values({
          workspaceId: auth.workspaceId,
          calendarId,
          title: interaction.title,
          description: `Kind: ${interaction.kind}. Evidence: calendar snapshot ${dataset.snapshotDate}.`,
          startsAt,
          endsAt,
          timezone: dataset.timezone,
          status: interaction.status,
          createdBy: auth.userId,
          updatedBy: auth.userId,
        })
        .returning({ id: events.id });
      eventId = created.id;
      summary.events.created += 1;
      if (interaction.status === "cancelled") summary.events.cancelled += 1;

      await tx
        .insert(eventLinks)
        .values({
          workspaceId: auth.workspaceId,
          eventId,
          targetType: "company",
          targetId: companyId,
          label: interaction.company,
        })
        .onConflictDoNothing();
    }

    for (const email of interaction.contactEmails) {
      const contactId = contactIds.get(key(email));
      if (!contactId) continue;
      const [attendee] = await tx
        .select({ id: eventAttendees.id })
        .from(eventAttendees)
        .where(and(eq(eventAttendees.eventId, eventId), eq(eventAttendees.email, email)))
        .limit(1);
      if (!attendee) {
        await tx.insert(eventAttendees).values({
          workspaceId: auth.workspaceId,
          eventId,
          email,
          contactId,
          // The snapshot shows a scheduled invitation, not an RSVP.
          response: "needs_action",
        });
        summary.attendees.created += 1;
      }
    }
  }
}

async function upsertOpportunities(
  auth: AuthContext,
  tx: TxDrizzle,
  dataset: PersonalSeed,
  companyIds: CompanyIds,
  contactIds: ContactIds,
  summary: SeedSummary,
) {
  for (const opportunity of dataset.opportunities) {
    const companyId = companyIds.get(opportunity.company) ?? null;
    const primaryContactId = opportunity.primaryContactEmail
      ? contactIds.get(key(opportunity.primaryContactEmail)) ?? null
      : null;

    const [match] = await tx
      .select({ id: opportunities.id })
      .from(opportunities)
      .where(
        and(
          eq(opportunities.workspaceId, auth.workspaceId),
          isNull(opportunities.archivedAt),
          eq(opportunities.title, opportunity.title),
          companyId ? eq(opportunities.companyId, companyId) : isNull(opportunities.companyId),
        ),
      )
      .limit(1);

    if (match) {
      summary.opportunities.matched += 1;
      continue;
    }

    await tx.insert(opportunities).values({
      workspaceId: auth.workspaceId,
      title: opportunity.title,
      companyId,
      primaryContactId,
      stage: opportunity.stage,
      // The evidence establishes a conversation, not a submission or outcome.
      outcome: "pending",
      sourceType: "personal_seed",
      tags: ["personal_seed"],
      createdBy: auth.userId,
      updatedBy: auth.userId,
    });
    summary.opportunities.created += 1;
  }
}

/**
 * "2026-10-19T12:30:00" in America/Los_Angeles to a UTC instant. The offset is
 * read from the zone at that date rather than hard-coded, so a snapshot that
 * crosses a DST boundary stays correct.
 */
export function zonedToUtc(local: string, timeZone: string): Date {
  const [datePart, timePart = "00:00:00"] = local.split("T");
  const [year, month, day] = datePart.split("-").map(Number);
  const [hour, minute, second = 0] = timePart.split(":").map(Number);
  const asUtc = Date.UTC(year, month - 1, day, hour, minute, second);

  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(asUtc));
  const read = (type: string) => Number(parts.find((part) => part.type === type)?.value);
  const rendered = Date.UTC(
    read("year"),
    read("month") - 1,
    read("day"),
    read("hour") % 24,
    read("minute"),
    read("second"),
  );
  return new Date(asUtc - (rendered - asUtc));
}

/** The owner's active membership, resolved by Clerk id — never by "first user". */
export async function resolveSeedOwner(clerkUserId: string): Promise<AuthContext | null> {
  const { memberships, users, workspaces } = await import("@/domains/identity/schema");
  const [row] = await db
    .select({ userId: users.id, workspaceId: memberships.workspaceId, role: memberships.role })
    .from(users)
    .innerJoin(memberships, eq(memberships.userId, users.id))
    .innerJoin(workspaces, eq(workspaces.id, memberships.workspaceId))
    .where(
      and(
        eq(users.clerkUserId, clerkUserId),
        eq(memberships.status, "active"),
        isNull(workspaces.archivedAt),
      ),
    )
    .limit(1);
  return row ? { userId: row.userId, workspaceId: row.workspaceId, role: row.role } : null;
}

/** Company names present in a set of workspaces, for the CLI's post-write check. */
export async function companyNames(auth: AuthContext): Promise<string[]> {
  const rows = await db
    .select({ name: companies.name })
    .from(companies)
    .where(and(eq(companies.workspaceId, auth.workspaceId), isNull(companies.archivedAt)))
    .orderBy(companies.name);
  return rows.map((row) => row.name);
}
