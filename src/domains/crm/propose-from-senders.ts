import { and, eq, isNull, sql } from "drizzle-orm";
import { actionProposals, actionRevisions } from "@/domains/actions/schema";
import { createProposal, decideProposal, ProposalConflictError } from "@/domains/actions/commands";
import { recordAudit } from "@/domains/audit/record";
import type { AuthContext } from "@/domains/identity/resolve";
import { db } from "@/lib/db";
import { withTransaction } from "@/lib/db-transaction";
import { listContactStatusesByEmail } from "./queries";
import { companies, contactCompanies, contactObservations, contacts, correspondence } from "./schema";
import { companyFromEmail, gmailThreadUrl, isAutomatedSender, nameFromEmail, parseSender } from "./sender-parsing";

/*
 * ASH-287: "when an email arrives from a new sender, propose a CRM contact and
 * company with a link to the email thread."
 *
 * Proposal-only, like every agent write: this module never creates a contact
 * itself. A sender who is not yet in the CRM becomes one `crm.contact.create`
 * proposal in the review queue, carrying the person, the company the domain
 * implies, and the Gmail thread that surfaced them. Approving it creates the
 * contact, finds or creates the company, links them, and records the thread as
 * inbound correspondence so the contact page shows where the relationship began.
 * Nothing leaves the workspace: no mail is read beyond the summaries the caller
 * already holds, and no external CRM is written.
 *
 * There is no inbound mail webhook in this app; mail is read on demand through
 * the Gmail gateway. "Arrives" therefore means "a run read it": the agent tool
 * feeds the summaries it fetched into this function. A push-based trigger is a
 * separate decision and would call the same entry point.
 *
 * One proposal per sender address, not per message: the dedupe key is the
 * address, so a second email from the same person resolves the same proposal,
 * and a rejected proposal stays rejected instead of reappearing.
 */

export const CRM_CONTACT_CAPABILITY = "crm.contact.create";

export type SenderMessage = {
  messageId: string;
  threadId: string;
  from: string | null;
  subject: string | null;
  /** RFC 2822 `Date` header, when Gmail supplied one. */
  date?: string | null;
};

export type SenderProposalPayload = {
  fullName: string;
  email: string;
  /** `existingId` set: link to that company. Otherwise approval creates it. */
  company: { name: string; domain: string; existingId?: string } | null;
  source: { provider: "gmail"; messageId: string; threadId: string; threadUrl: string; subject: string | null; receivedAt: string | null };
};

export type SenderSkipReason = "unparseable" | "own_address" | "automated" | "already_in_crm";

export type ProposeFromSendersResult = {
  proposed: Array<{ email: string; proposalId: string; deduplicated: boolean }>;
  skipped: Array<{ email: string | null; reason: SenderSkipReason }>;
};

const MAX_SUBJECT = 300;
const MAX_MESSAGES = 50;

function receivedAtIso(date: string | null | undefined): string | null {
  const parsed = date ? Date.parse(date) : Number.NaN;
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
}

export async function proposeContactsFromSenders(
  auth: Pick<AuthContext, "workspaceId"> & { userId?: string | null },
  input: { messages: SenderMessage[]; ownAddresses: string[]; runId?: string | null },
): Promise<ProposeFromSendersResult> {
  const own = new Set(input.ownAddresses.map((address) => address.toLowerCase()));
  const skipped: ProposeFromSendersResult["skipped"] = [];
  // Newest-first input keeps the latest thread per sender; the first sighting wins either way.
  const candidates = new Map<string, { message: SenderMessage; displayName: string | null }>();
  for (const message of input.messages.slice(0, MAX_MESSAGES)) {
    const sender = parseSender(message.from);
    if (!sender) skipped.push({ email: null, reason: "unparseable" });
    else if (own.has(sender.email)) skipped.push({ email: sender.email, reason: "own_address" });
    else if (isAutomatedSender(sender.email)) skipped.push({ email: sender.email, reason: "automated" });
    else if (!candidates.has(sender.email)) candidates.set(sender.email, { message, displayName: sender.displayName });
  }

  const known = await listContactStatusesByEmail({ workspaceId: auth.workspaceId } as AuthContext, [...candidates.keys()]);
  for (const email of [...candidates.keys()]) {
    if (known.has(email)) {
      skipped.push({ email, reason: "already_in_crm" });
      candidates.delete(email);
    }
  }

  const proposed: ProposeFromSendersResult["proposed"] = [];
  for (const [email, { message, displayName }] of candidates) {
    const implied = companyFromEmail(email);
    const existingCompany = implied ? await findCompanyByDomain(auth.workspaceId, implied.domain) : null;
    const payload: SenderProposalPayload = {
      fullName: displayName ?? nameFromEmail(email),
      email,
      company: implied ? { ...implied, ...(existingCompany ? { existingId: existingCompany.id, name: existingCompany.name } : {}) } : null,
      source: {
        provider: "gmail",
        messageId: message.messageId,
        threadId: message.threadId,
        threadUrl: gmailThreadUrl(message.threadId),
        subject: message.subject?.replace(/\s+/g, " ").trim().slice(0, MAX_SUBJECT) || null,
        receivedAt: receivedAtIso(message.date),
      },
    };
    const result = await withTransaction(async (tx) => {
      const created = await createProposal(tx, auth, {
        capability: CRM_CONTACT_CAPABILITY,
        riskClass: "prepare",
        targetType: "contact",
        title: `Add contact: ${payload.fullName}`,
        expectedEffect: payload.company
          ? `Adds ${payload.fullName} <${email}> to your contacts, ${existingCompany ? `linked to ${payload.company.name}` : `with a new company, ${payload.company.name} (${payload.company.domain})`}, and keeps the email thread as their first correspondence.`
          : `Adds ${payload.fullName} <${email}> to your contacts and keeps the email thread as their first correspondence.`,
        dedupeKey: `crm-sender:${email}`,
        runId: input.runId ?? null,
      });
      if (!created.deduplicated) {
        await tx.insert(actionRevisions).values({
          workspaceId: auth.workspaceId,
          proposalId: created.proposalId,
          revisionNumber: 1,
          payload,
          preview: payload,
          createdBy: auth.userId ?? null,
        });
      }
      return created;
    });
    proposed.push({ email, ...result });
  }
  return { proposed, skipped };
}

async function findCompanyByDomain(workspaceId: string, domain: string) {
  const [row] = await db
    .select({ id: companies.id, name: companies.name })
    .from(companies)
    .where(and(eq(companies.workspaceId, workspaceId), eq(companies.domain, domain), isNull(companies.archivedAt)))
    .limit(1);
  return row ?? null;
}

export class SenderApprovalNotAllowedError extends Error {
  readonly code = "crm_contact_not_allowed";
  constructor(message: string) {
    super(message);
    this.name = "SenderApprovalNotAllowedError";
  }
}

/** The owner may revise the payload as free JSON, so approval re-validates it. */
export function parseSenderPayload(payload: unknown): SenderProposalPayload {
  const p = payload as Partial<SenderProposalPayload> | null;
  const bad = (what: string) => new SenderApprovalNotAllowedError(`The approved payload is not a valid contact: ${what}.`);
  if (!p || typeof p.fullName !== "string" || !p.fullName.trim()) throw bad("no name");
  if (typeof p.email !== "string" || !/^[^@\s]+@[^@\s]+$/.test(p.email)) throw bad("no email address");
  if (p.company !== null && p.company !== undefined) {
    if (typeof p.company.name !== "string" || !p.company.name.trim()) throw bad("company has no name");
    if (typeof p.company.domain !== "string" || !p.company.domain.trim()) throw bad("company has no domain");
  }
  const s = p.source;
  if (!s || typeof s.messageId !== "string" || typeof s.threadId !== "string") throw bad("no source thread");
  return { ...(p as SenderProposalPayload), company: p.company ?? null };
}

export type SenderApproval = { contactId: string; companyId: string | null; created: boolean };

/*
 * Approve and apply. The decision commits first (compare-and-set on the
 * version the owner saw); applying then runs in one local transaction. That is
 * the whole effect, so it needs no claim/settle attempt row: there is no
 * provider call that can leave an UNKNOWN outcome, and it is idempotent by
 * construction. A retried approval finds the contact by email, the company by
 * domain, and the correspondence by provider message id, and creates nothing.
 */
export async function approveContactProposal(
  auth: AuthContext,
  input: { proposalId: string; expectedVersion: number; revisionId: string },
): Promise<SenderApproval> {
  try {
    await decideProposal(auth, {
      proposalId: input.proposalId,
      expectedVersion: input.expectedVersion,
      revisionId: input.revisionId,
      decision: "approved",
      idempotencyKey: `crm-contact-decide:${input.proposalId}`,
    });
  } catch (error) {
    if (!(error instanceof ProposalConflictError)) throw error;
    const [p] = await db
      .select({ status: actionProposals.status })
      .from(actionProposals)
      .where(and(eq(actionProposals.id, input.proposalId), eq(actionProposals.workspaceId, auth.workspaceId)))
      .limit(1);
    if (p?.status !== "approved") throw error;
  }

  const [proposal] = await db
    .select({ capability: actionProposals.capability })
    .from(actionProposals)
    .where(and(eq(actionProposals.id, input.proposalId), eq(actionProposals.workspaceId, auth.workspaceId)))
    .limit(1);
  if (!proposal) throw new SenderApprovalNotAllowedError("That proposal does not exist in this workspace.");
  if (proposal.capability !== CRM_CONTACT_CAPABILITY) throw new SenderApprovalNotAllowedError("That proposal is not a contact proposal.");

  const [revision] = await db
    .select({ payload: actionRevisions.payload })
    .from(actionRevisions)
    .where(and(eq(actionRevisions.id, input.revisionId), eq(actionRevisions.workspaceId, auth.workspaceId), eq(actionRevisions.proposalId, input.proposalId)))
    .limit(1);
  if (!revision) throw new SenderApprovalNotAllowedError("The approved revision no longer exists.");
  const payload = parseSenderPayload(revision.payload);

  try {
    return await applyContact(auth, payload);
  } catch (error) {
    // A concurrent identical approval won the unique index; the replay reads its result.
    if ((error as { cause?: { code?: string } })?.cause?.code !== "23505") throw error;
    return applyContact(auth, payload);
  }
}

async function applyContact(auth: AuthContext, payload: SenderProposalPayload): Promise<SenderApproval> {
  const email = payload.email.toLowerCase();
  return withTransaction(async (tx) => {
    let companyId: string | null = null;
    if (payload.company) {
      const domain = payload.company.domain.toLowerCase();
      const [byId] = payload.company.existingId
        ? await tx
            .select({ id: companies.id })
            .from(companies)
            .where(and(eq(companies.id, payload.company.existingId), eq(companies.workspaceId, auth.workspaceId), isNull(companies.archivedAt)))
            .limit(1)
        : [];
      const [byDomain] = byId
        ? []
        : await tx
            .select({ id: companies.id })
            .from(companies)
            .where(and(eq(companies.workspaceId, auth.workspaceId), eq(companies.domain, domain)))
            .limit(1);
      companyId = byId?.id ?? byDomain?.id ?? null;
      if (!companyId) {
        const [company] = await tx
          .insert(companies)
          .values({ workspaceId: auth.workspaceId, name: payload.company.name.trim(), domain, createdBy: auth.userId, updatedBy: auth.userId })
          .returning({ id: companies.id });
        companyId = company.id;
        await recordAudit(auth, { action: "company.created", subjectType: "company", subjectId: companyId, summary: `Company created: ${payload.company.name}` }, tx);
      }
    }

    const [existing] = await tx
      .select({ id: contacts.id })
      .from(contacts)
      .where(and(eq(contacts.workspaceId, auth.workspaceId), sql`lower(${contacts.primaryEmail}) = ${email}`))
      .limit(1);
    let contactId = existing?.id;
    const created = !contactId;
    if (!contactId) {
      const [contact] = await tx
        .insert(contacts)
        .values({
          workspaceId: auth.workspaceId,
          fullName: payload.fullName.trim(),
          primaryEmail: email,
          lastInteractionAt: payload.source.receivedAt ? new Date(payload.source.receivedAt) : null,
          createdBy: auth.userId,
          updatedBy: auth.userId,
        })
        .returning({ id: contacts.id });
      contactId = contact.id;
      await recordAudit(auth, { action: "contact.created", subjectType: "contact", subjectId: contactId, summary: `Contact created from email sender: ${payload.fullName}` }, tx);
    }

    if (companyId) {
      const [link] = await tx
        .select({ id: contactCompanies.id })
        .from(contactCompanies)
        .where(and(eq(contactCompanies.contactId, contactId), eq(contactCompanies.companyId, companyId)))
        .limit(1);
      if (!link) await tx.insert(contactCompanies).values({ workspaceId: auth.workspaceId, contactId, companyId, isCurrent: true });
    }

    const [seen] = await tx
      .select({ id: correspondence.id })
      .from(correspondence)
      .where(and(eq(correspondence.workspaceId, auth.workspaceId), eq(correspondence.contactId, contactId), eq(correspondence.providerObjectId, payload.source.messageId)))
      .limit(1);
    if (!seen) {
      const [thread] = await tx
        .insert(correspondence)
        .values({
          workspaceId: auth.workspaceId,
          contactId,
          companyId,
          direction: "inbound",
          channel: "email",
          subject: payload.source.subject,
          state: "received",
          providerObjectId: payload.source.messageId,
          threadId: payload.source.threadId,
          occurredAt: payload.source.receivedAt ? new Date(payload.source.receivedAt) : null,
          createdBy: auth.userId,
          updatedBy: auth.userId,
        })
        .returning({ id: correspondence.id });
      await tx.insert(contactObservations).values({
        workspaceId: auth.workspaceId,
        contactId,
        body: `First seen as an email sender${payload.source.subject ? `: "${payload.source.subject}"` : ""}. Thread: ${payload.source.threadUrl}`,
        source: "observed",
        evidenceType: "correspondence",
        evidenceId: thread.id,
        createdBy: auth.userId,
        updatedBy: auth.userId,
      });
    }
    return { contactId, companyId, created };
  });
}
