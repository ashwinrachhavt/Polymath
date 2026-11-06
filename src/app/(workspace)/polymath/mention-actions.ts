"use server";

import { z } from "zod";
import { and, eq, inArray } from "drizzle-orm";
import { getAuthContext } from "@/lib/auth";
import { requireRole } from "@/lib/auth/guards";
import { getCompanyDetail, getContactDetail, listContactStatusesByEmail } from "@/domains/crm/queries";
import { getPersonMentionContext, getOrganizationMentionContext } from "@/domains/identity/party-queries";
import { db } from "@/lib/db";
import { artifactLinks, artifactVersions, artifacts } from "@/domains/knowledge/schema";
import { RELATION_LABELS, RELATION_TYPES } from "@/domains/knowledge/relations";
import { ideaContextPayload } from "./idea-context";

/*
 * The mention context read. A message that names a person or company with
 * @Name carries the entity's id from the picker; this action resolves the
 * named record in the owner's workspace and returns the JSON block the
 * client appends to the message the model reads. Read-only — a mention
 * loads context, it never writes anything.
 */

const requested = z.object({
  kind: z.enum(["person", "company", "zettel"]),
  id: z.string().uuid(),
});

export async function fetchMentionContext(raw: unknown): Promise<Record<string, unknown> | null> {
  const parsed = requested.safeParse(raw);
  if (!parsed.success) return null;

  const auth = await getAuthContext();
  requireRole(auth, "member");

  if (parsed.data.kind === "zettel") {
    // The idea chip carries the idea itself: the claim text from the
    // current version, its free tags, and up to five labelled edges. Read
    // only, scoped to the workspace like every other branch.
    const [idea] = await db
      .select({ title: artifacts.title, plainText: artifactVersions.plainText, tags: artifacts.tags })
      .from(artifacts)
      .innerJoin(artifactVersions, eq(artifactVersions.id, artifacts.currentVersionId))
      .where(and(eq(artifacts.id, parsed.data.id), eq(artifacts.workspaceId, auth.workspaceId)));
    if (!idea) return null;
    const links = await db
      .select({ label: artifactLinks.label, linkType: artifactLinks.linkType })
      .from(artifactLinks)
      .where(
        and(
          eq(artifactLinks.artifactId, parsed.data.id),
          eq(artifactLinks.workspaceId, auth.workspaceId),
          inArray(artifactLinks.linkType, [...RELATION_TYPES]),
        ),
      )
      .limit(5);
    return ideaContextPayload({
      title: idea.title,
      claim: idea.plainText ?? "",
      tags: Array.isArray(idea.tags) ? (idea.tags as string[]) : [],
      links: links.map((link) => ({
        title: link.label ?? "",
        relation: RELATION_LABELS[link.linkType] ?? link.linkType,
      })),
    });
  }

  if (parsed.data.kind === "person") {
    // The picker hands an identity-domain id (what the LinkedIn CSV import
    // writes); the CRM contact stays as the fallback for ids already stored
    // in old messages. The identity row carries name/email/employer; the
    // relationship pill comes from the CRM match on the primary email, the
    // same seam the People table uses.
    const person = await getPersonMentionContext(auth, { personId: parsed.data.id });
    if (person) {
      const [matched] = person.email ? [...(await listContactStatusesByEmail(auth, [person.email])).values()] : [];
      return { ...person, relationshipStatus: matched?.relationshipStatus ?? "unknown" };
    }
    const detail = await getContactDetail(auth, { contactId: parsed.data.id });
    if (!detail) return null;
    return {
      id: detail.contact.id,
      name: detail.contact.fullName,
      email: detail.contact.primaryEmail,
      title: detail.contact.title,
      relationshipStatus: detail.contact.relationshipStatus,
      notes: detail.contact.notes,
      companies: detail.companies.map((link) => ({ name: link.name, title: link.title, isCurrent: link.isCurrent })),
      recentObservations: detail.observations
        .slice(0, 5)
        .map((observation) => ({ body: observation.body, at: observation.observedAt })),
      openFollowUps: detail.followUps
        .filter((followUp) => followUp.status === "open")
        .map((followUp) => ({ note: followUp.note, dueAt: followUp.dueAt })),
    };
  }

  // Company: identity first (the picker's ids), CRM fallback for legacy picks.
  const organization = await getOrganizationMentionContext(auth, { organizationId: parsed.data.id });
  if (organization) return organization;

  const detail = await getCompanyDetail(auth, { companyId: parsed.data.id });
  if (!detail) return null;
  return {
    id: detail.company.id,
    name: detail.company.name,
    domain: detail.company.domain,
    description: detail.company.description,
    people: detail.contacts.map((contact) => ({
      name: contact.fullName,
      title: contact.title,
      isCurrent: contact.isCurrent,
    })),
  };
}
