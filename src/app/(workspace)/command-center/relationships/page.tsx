import Link from "next/link";
import { Suspense } from "react";
import { Button } from "@/components/ui/button";
import { Empty, Panel, Screen, Status } from "@/components/workspace/ui";
import {
  getContactDetail,
  listCompanies,
  listContacts,
  RELATIONSHIP_STATUSES,
  type RelationshipStatus,
} from "@/domains/crm/queries";
import { getAuthContext } from "@/lib/auth";
import { ContactForm } from "./contact-form";
import {
  ArchiveContactButton,
  FollowUpForm,
  ObservationForm,
  ResolveFollowUpButton,
} from "./contact-detail-controls";
import { CompanyForm } from "./company-form";
import { ImportButton } from "./import-button";

export const metadata = { title: "Relationships · Axiom" };

/*
 * Canonical relationships surface (ASH-139 C01): contacts, companies,
 * observations and follow-ups read from Postgres. The browser-preview store
 * that used to render here is retired for this domain; the LinkedIn CSV
 * import stays as its own strip because it writes the identity domain's
 * people/organizations, whose merge with CRM contacts is ASH-135 item 2.
 *
 * Filters are URL state (GET form), so a filtered view is a shareable link
 * and the list is a plain server render with no client fetching.
 */

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

const STATUS_LABELS: Record<RelationshipStatus, string> = {
  unknown: "Unknown",
  cold: "Cold",
  warm: "Warm",
  active: "Active",
  dormant: "Dormant",
};

async function Relationships({ searchParams }: { searchParams: SearchParams }) {
  const query = await searchParams;
  const auth = await getAuthContext();
  const q = first(query.q)?.trim() || undefined;
  const rawStatus = first(query.status);
  const status = (RELATIONSHIP_STATUSES as readonly string[]).includes(rawStatus ?? "")
    ? (rawStatus as RelationshipStatus)
    : undefined;
  const rawId = first(query.id);
  const selectedId = rawId && /^[0-9a-fA-F-]{36}$/.test(rawId) ? rawId : undefined;
  const invalidSelection = !!rawId && !selectedId;

  const [list, companies, detail] = await Promise.all([
    listContacts(auth, { query: q, status }),
    listCompanies(auth),
    selectedId ? getContactDetail(auth, { contactId: selectedId }) : Promise.resolve(null),
  ]);

  const companyOptions = companies.map((company) => ({ id: company.id, name: company.name }));

  return (
    <Screen
      title="Relationships"
      description="Contacts and companies on canonical records. Research, enrichment and delivery still need configured adapters."
    >
      <form method="get" className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1.5 text-[13px]">
          <span className="font-medium">Search</span>
          <input
            type="search"
            name="q"
            defaultValue={q}
            placeholder="Name or email"
            className="border-input bg-background h-9 w-full max-w-sm rounded-md border px-3 text-[13px]"
          />
        </label>
        <label className="flex flex-col gap-1.5 text-[13px]">
          <span className="font-medium">Status</span>
          <select
            name="status"
            defaultValue={status ?? ""}
            className="border-input bg-background h-9 rounded-md border px-2 text-[13px]"
          >
            <option value="">All</option>
            {RELATIONSHIP_STATUSES.map((value) => (
              <option key={value} value={value}>
                {STATUS_LABELS[value]}
              </option>
            ))}
          </select>
        </label>
        <Button type="submit" variant="outline">
          Apply
        </Button>
      </form>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <div className="space-y-6">
          <Panel title={`${list.total} contacts`}>
            <details className="mb-4">
              <summary className="cursor-pointer text-[13px] font-medium focus-visible:outline-2 focus-visible:outline-ring">
                New contact
              </summary>
              <div className="mt-3">
                <ContactForm companies={companyOptions} />
              </div>
            </details>
            <div className="divide-y divide-border">
              {list.items.map((contact) => (
                <div key={contact.id} className="flex flex-wrap items-center justify-between gap-3 py-3 first:pt-0">
                  <div>
                    <Link
                      href={`/command-center/relationships?id=${contact.id}`}
                      className="text-[13px] font-medium underline-offset-4 hover:underline"
                    >
                      {contact.fullName}
                    </Link>
                    <p className="text-xs text-muted-foreground">
                      {contact.title || "No title recorded"}
                      {contact.currentCompanyName ? ` at ${contact.currentCompanyName}` : ""}
                    </p>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {contact.primaryEmail || "No email recorded"}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    {contact.openFollowUps > 0 ? (
                      <Status>{contact.openFollowUps} open follow-up{contact.openFollowUps === 1 ? "" : "s"}</Status>
                    ) : null}
                    <Status>{STATUS_LABELS[contact.relationshipStatus]}</Status>
                  </div>
                </div>
              ))}
            </div>
            {!list.items.length ? (
              <Empty
                title="No matching contacts"
                description="Change the filters or create a contact. Imported LinkedIn connections live in the identity domain until the two records merge (ASH-135)."
              />
            ) : null}
          </Panel>

          <Panel title={`${companies.length} companies`}>
            <div className="mb-4">
              <CompanyForm />
            </div>
            <div className="divide-y divide-border">
              {companies.map((company) => (
                <div key={company.id} className="flex flex-wrap items-center justify-between gap-3 py-3 first:pt-0">
                  <div>
                    <p className="text-[13px] font-medium">{company.name}</p>
                    <p className="text-xs text-muted-foreground">{company.domain || "No domain recorded"}</p>
                  </div>
                  <Status>
                    {company.contactCount} current contact{company.contactCount === 1 ? "" : "s"}
                  </Status>
                </div>
              ))}
            </div>
            {!companies.length ? (
              <Empty title="No companies yet" description="Add a company above, then link contacts to it." />
            ) : null}
          </Panel>
        </div>

        <div>
          {invalidSelection ? (
            <Empty
              title="Contact not found"
              description="This record link is not a valid contact id. No contact was selected."
              action={
                <Button asChild variant="outline">
                  <Link href="/command-center/relationships">Open contact list</Link>
                </Button>
              }
            />
          ) : selectedId && !detail ? (
            <Empty
              title="Contact not found"
              description="This record link does not match a contact in this workspace. No other contact was selected."
              action={
                <Button asChild variant="outline">
                  <Link href="/command-center/relationships">Open contact list</Link>
                </Button>
              }
            />
          ) : detail ? (
            <ContactDetailPanel detail={detail} companies={companyOptions} />
          ) : (
            <Empty
              title="Choose a contact"
              description="Select a contact to see its companies, observations and follow-ups."
            />
          )}
        </div>
      </div>
    </Screen>
  );
}

function ContactDetailPanel({
  detail,
  companies,
}: {
  detail: NonNullable<Awaited<ReturnType<typeof getContactDetail>>>;
  companies: Array<{ id: string; name: string }>;
}) {
  const { contact } = detail;
  const currentCompany = detail.companies.find((company) => company.isCurrent);
  return (
    <div className="space-y-6">
      <Panel
        title={contact.fullName}
        description={`${contact.title || "No title recorded"}${currentCompany ? ` at ${currentCompany.name}` : ""}`}
      >
        <dl className="mb-4 grid gap-2 text-[13px] sm:grid-cols-2">
          <div>
            <dt className="text-muted-foreground">Email</dt>
            <dd>{contact.primaryEmail || "Not recorded"}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Phone</dt>
            <dd>{contact.phone || "Not recorded"}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Location</dt>
            <dd>{contact.location || "Not recorded"}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Status</dt>
            <dd>{STATUS_LABELS[contact.relationshipStatus]}</dd>
          </div>
        </dl>
        {detail.companies.length ? (
          <div className="mb-4 space-y-1">
            {detail.companies.map((company) => (
              <p key={company.linkId} className="text-xs text-muted-foreground">
                {company.name}
                {company.title ? ` — ${company.title}` : ""}{" "}
                {company.isCurrent ? "(current)" : "(past)"}
              </p>
            ))}
          </div>
        ) : null}
        <details>
          <summary className="cursor-pointer text-[13px] font-medium focus-visible:outline-2 focus-visible:outline-ring">
            Edit contact
          </summary>
          <div className="mt-3">
            <ContactForm
              companies={companies}
              contact={{
                id: contact.id,
                version: contact.version,
                fullName: contact.fullName,
                primaryEmail: contact.primaryEmail,
                phone: contact.phone,
                title: contact.title,
                location: contact.location,
                relationshipStatus: contact.relationshipStatus,
                notes: contact.notes,
                currentCompanyId: currentCompany?.companyId ?? null,
              }}
            />
          </div>
        </details>
        <div className="mt-4 border-t border-border pt-4">
          <ArchiveContactButton contactId={contact.id} version={contact.version} name={contact.fullName} />
        </div>
      </Panel>

      <Panel title="Follow-ups" description="Commitments to return to this relationship.">
        <div className="mb-4 divide-y divide-border">
          {detail.followUps.map((followUp) => (
            <div key={followUp.id} className="flex flex-wrap items-center justify-between gap-3 py-2 first:pt-0">
              <div>
                <p className="text-[13px]">{followUp.note || "Follow up"}</p>
                <p className="text-xs text-muted-foreground">
                  {followUp.dueAt ? `Due ${followUp.dueAt.toISOString().slice(0, 10)}` : "No due date"}
                  {followUp.status !== "open" ? ` — ${followUp.status}` : ""}
                </p>
              </div>
              {followUp.status === "open" ? (
                <span className="flex gap-1">
                  <ResolveFollowUpButton followUpId={followUp.id} version={followUp.version} resolution="done" />
                  <ResolveFollowUpButton followUpId={followUp.id} version={followUp.version} resolution="cancelled" />
                </span>
              ) : (
                <Status>{followUp.status}</Status>
              )}
            </div>
          ))}
        </div>
        <FollowUpForm contactId={contact.id} />
      </Panel>

      <Panel title="Observations" description="Everything asserted about this contact carries where it came from.">
        <div className="mb-4 space-y-3">
          {detail.observations.map((observation) => (
            <div key={observation.id} className="border-b border-border pb-3 last:border-0">
              <p className="whitespace-pre-wrap text-[13px] leading-relaxed">{observation.body}</p>
              <p className="mt-1 text-xs text-muted-foreground">
                {observation.source} · {observation.observedAt.toISOString().slice(0, 10)}
              </p>
            </div>
          ))}
          {!detail.observations.length ? (
            <p className="text-xs text-muted-foreground">No observations recorded yet.</p>
          ) : null}
        </div>
        <ObservationForm contactId={contact.id} />
      </Panel>
    </div>
  );
}

export default function RelationshipsPage({ searchParams }: { searchParams: SearchParams }) {
  return (
    <>
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border px-4 py-3 md:px-6">
        <p className="max-w-xl text-xs leading-relaxed text-muted-foreground">
          Importing writes people and organizations to the identity domain.
          Merging them with CRM contacts is tracked as ASH-135.
        </p>
        <ImportButton />
      </div>
      <Suspense fallback={<p role="status" className="p-6 text-[13px] text-muted-foreground">Loading relationships…</p>}>
        <Relationships searchParams={searchParams} />
      </Suspense>
    </>
  );
}
