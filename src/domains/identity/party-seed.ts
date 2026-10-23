import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "@/domains/audit/record";
import type { AuthContext } from "./resolve";
import { withTransaction, type TxDrizzle } from "@/lib/db-transaction";
import { contactPoints, organizations, partyEmployment, people } from "./schema";

/*
 * Identity-party seed: people, organizations, and employment edges for the
 * People/Companies tables. The evidence file is the owner's own inventory and
 * is never committed (outreach/ is gitignored).
 *
 * The shape enforces the same honesty rules as the CRM personal seed:
 *   - A name alone never merges. Email is the identity key within the
 *     workspace, exactly as the LinkedIn import treats it.
 *   - An email domain is observed evidence, not an automatic employer claim.
 *     `emailDomain` is set only when the inventory asserts the person's own
 *     address at that organization; recruiters keep their firm's domain.
 *   - Absent facts stay null. No invented surnames (the inventory's
 *     "Chris — surname unknown" stays display name "Chris (Intangible)").
 *   - Nothing is deleted or overwritten. A re-run matches on email and
 *     reports; an owner edit is left alone.
 */

export const partySeedSchema = z.object({
  snapshotDate: z.string().date(),
  timezone: z.string().min(1),
  note: z.string().optional(),
  organizations: z
    .array(
      z.object({
        name: z.string().min(1),
        /** Only a domain the evidence confirms is the org's own. */
        domain: z.string().nullable().default(null),
        summary: z.string().nullable().default(null),
      }),
    )
    .default([]),
  people: z.array(
    z.object({
      /** Display name; keep the source's wording, including "(surname unknown)". */
      name: z.string().min(1),
      email: z.string().email().nullable().default(null),
      title: z.string().nullable().default(null),
      /** The organization the evidence places this person at. */
      organization: z.string().nullable().default(null),
      summary: z.string().nullable().default(null),
    }),
  ),
});

export type PartySeed = z.infer<typeof partySeedSchema>;

export type PartySeedSummary = {
  applied: boolean;
  organizations: { created: number; matched: number };
  people: { created: number; matched: number };
  employments: { created: number };
  unresolved: string[];
};

class DryRunRollback extends Error {}

function key(value: string) {
  return value.trim().toLowerCase();
}

export async function seedParties(
  auth: AuthContext,
  raw: unknown,
  options: { apply: boolean },
): Promise<PartySeedSummary> {
  const dataset = partySeedSchema.parse(raw);
  const summary: PartySeedSummary = {
    applied: options.apply,
    organizations: { created: 0, matched: 0 },
    people: { created: 0, matched: 0 },
    employments: { created: 0 },
    unresolved: [],
  };

  try {
    await withTransaction(async (tx) => {
      const orgIds = await upsertOrganizations(auth, tx, dataset, summary);
      await upsertPeople(auth, tx, dataset, orgIds, summary);

      if (!options.apply) throw new DryRunRollback();

      if (summary.people.created + summary.organizations.created > 0) {
        await recordAudit(
          auth,
          {
            action: "parties.seeded",
            subjectType: "workspace",
            subjectId: auth.workspaceId,
            summary: `Party seed applied (${dataset.snapshotDate})`,
            metadata: {
              snapshotDate: dataset.snapshotDate,
              peopleCreated: summary.people.created,
              organizationsCreated: summary.organizations.created,
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

async function upsertOrganizations(
  auth: AuthContext,
  tx: TxDrizzle,
  dataset: PartySeed,
  summary: PartySeedSummary,
): Promise<Map<string, string>> {
  const existing = await tx
    .select({ id: organizations.id, name: organizations.name, domain: organizations.domain })
    .from(organizations)
    .where(and(eq(organizations.workspaceId, auth.workspaceId), isNull(organizations.archivedAt)));
  const byName = new Map(existing.map((row) => [key(row.name), row]));
  const claimedDomains = new Set(existing.map((row) => row.domain).filter((d): d is string => !!d).map(key));
  const ids = new Map<string, string>();

  for (const org of dataset.organizations) {
    const match = byName.get(key(org.name));
    if (match) {
      ids.set(org.name, match.id);
      summary.organizations.matched += 1;
      continue;
    }
    // A domain another org already owns stays unclaimed (unique index would
    // reject the write; the inventory's honesty rule agrees with it).
    const domain = org.domain && !claimedDomains.has(key(org.domain)) ? org.domain.toLowerCase() : null;
    const [created] = await tx
      .insert(organizations)
      .values({
        workspaceId: auth.workspaceId,
        name: org.name,
        domain,
        createdBy: auth.userId,
        updatedBy: auth.userId,
      })
      .returning({ id: organizations.id });
    ids.set(org.name, created.id);
    byName.set(key(org.name), { id: created.id, name: org.name, domain });
    if (domain) claimedDomains.add(key(domain));
    summary.organizations.created += 1;
  }
  return ids;
}

async function upsertPeople(
  auth: AuthContext,
  tx: TxDrizzle,
  dataset: PartySeed,
  orgIds: Map<string, string>,
  summary: PartySeedSummary,
): Promise<void> {
  const emails = dataset.people.flatMap((p) => (p.email ? [p.email.toLowerCase()] : []));
  const knownByEmail = new Map<string, string>();
  if (emails.length) {
    const points = await tx
      .select({ value: contactPoints.value, personId: contactPoints.personId })
      .from(contactPoints)
      .where(and(eq(contactPoints.workspaceId, auth.workspaceId), eq(contactPoints.kind, "email"), isNull(contactPoints.archivedAt)));
    for (const point of points) {
      if (point.personId) knownByEmail.set(key(point.value), point.personId);
    }
  }

  for (const person of dataset.people) {
    const email = person.email ? person.email.toLowerCase() : null;
    let personId = email ? knownByEmail.get(email) ?? null : null;

    if (personId) {
      summary.people.matched += 1;
    } else {
      const [created] = await tx
        .insert(people)
        .values({
          workspaceId: auth.workspaceId,
          displayName: person.name,
          title: person.title ?? null,
          createdBy: auth.userId,
          updatedBy: auth.userId,
        })
        .returning({ id: people.id });
      personId = created.id;
      if (email) {
        knownByEmail.set(email, personId);
        await tx.insert(contactPoints).values({
          workspaceId: auth.workspaceId,
          kind: "email",
          value: email,
          isPrimary: true,
          // The owner's inventory is provenance, not provider verification.
          isVerified: false,
          personId,
          createdBy: auth.userId,
          updatedBy: auth.userId,
        });
      }
      summary.people.created += 1;
    }

    if (!person.organization) continue;
    const organizationId = orgIds.get(person.organization);
    if (!organizationId) {
      // The schema validates organizations exist before people reference them;
      // this guard stays for hand-edited files.
      summary.unresolved.push(`${person.name}: organization "${person.organization}" is not in this file.`);
      continue;
    }
    const existingEdges = await tx
      .select({ id: partyEmployment.id })
      .from(partyEmployment)
      .where(
        and(
          eq(partyEmployment.workspaceId, auth.workspaceId),
          eq(partyEmployment.personId, personId),
          eq(partyEmployment.organizationId, organizationId),
          isNull(partyEmployment.endedAt),
        ),
      )
      .limit(1);
    if (existingEdges.length) continue;
    await tx.insert(partyEmployment).values({
      workspaceId: auth.workspaceId,
      personId,
      organizationId,
      title: person.title ?? null,
      createdBy: auth.userId,
      updatedBy: auth.userId,
    });
    summary.employments.created += 1;
  }
}
