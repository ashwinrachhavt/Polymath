"use server";

import { z } from "zod";
import { getAuthContext } from "@/lib/auth";
import { requireRole } from "@/lib/auth/guards";
import { getCompanyDetail, getContactDetail } from "@/domains/crm/queries";

/*
 * The mention context read. A message that names a person or company with
 * @Name carries the entity's id from the picker; this action resolves the
 * named record in the owner's workspace and returns the JSON block the
 * client appends to the message the model reads. Read-only — a mention
 * loads context, it never writes anything.
 */

const requested = z.object({
  kind: z.enum(["person", "company"]),
  id: z.string().uuid(),
});

export async function fetchMentionContext(raw: unknown): Promise<Record<string, unknown> | null> {
  const parsed = requested.safeParse(raw);
  if (!parsed.success) return null;

  const auth = await getAuthContext();
  requireRole(auth, "member");

  if (parsed.data.kind === "person") {
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
      recentObservations: detail.observations.slice(0, 5).map((observation) => ({ body: observation.body, at: observation.observedAt })),
      openFollowUps: detail.followUps
        .filter((followUp) => followUp.status === "open")
        .map((followUp) => ({ note: followUp.note, dueAt: followUp.dueAt })),
    };
  }

  const detail = await getCompanyDetail(auth, { companyId: parsed.data.id });
  if (!detail) return null;
  return {
    id: detail.company.id,
    name: detail.company.name,
    domain: detail.company.domain,
    description: detail.company.description,
    people: detail.contacts.map((contact) => ({ name: contact.fullName, title: contact.title, isCurrent: contact.isCurrent })),
  };
}
