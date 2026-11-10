import { io } from "next/cache";
import Link from "next/link";
import { Suspense } from "react";
import { Button } from "@/components/ui/button";
import { listCorrespondence } from "@/domains/crm/correspondence";
import { findCompanyDuplicates, findContactDuplicates } from "@/domains/crm/dedupe";
import { getContactDetail, listCompanies } from "@/domains/crm/queries";
import { latestProfileResearch } from "@/domains/knowledge/profile-research";
import { ContactForm } from "../contact-form";
import { DuplicatesPanel } from "../duplicates-panel";
import { ContactDetailPanel } from "./contact-detail";
import { ImportDialog } from "../import-dialog";
import { RelationshipStatusPill } from "@/components/list/status-pill";
import { redirectPastEnd } from "@/components/list/clamp";
import { ListToolbar } from "@/components/list/list-toolbar";
import { NoResults } from "@/components/list/no-results";
import { Pagination } from "@/components/list/pagination";
import { Empty, Screen } from "@/components/workspace/ui";
import { countPeopleByStatus, pagePeople } from "@/domains/identity/party-queries";
import { RELATIONSHIP_STATUSES, RELATIONSHIP_STATUS_LABELS, type RelationshipStatus } from "@/domains/crm/status";
import { getAuthContext } from "@/lib/auth";
import { listHref, offsetFor, parseListParams } from "@/lib/list-params";
import { timeAgo } from "@/lib/time";

export const metadata = { title: "People · Polymath" };

/*
 * The People table over identity-domain records — the rows the LinkedIn CSV
 * import writes. URL state (search, status filter, page) makes a filtered
 * view a shareable link; the list is a plain server render with no client
 * fetching. The status pill is the CRM contact's relationship status matched
 * on the person's primary email; no match reads as Unknown, never guessed.
 */

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

const BASE = "/command-center/relationships/people";

const STATUS_FILTERS = RELATIONSHIP_STATUSES.map((value) => ({ value, label: RELATIONSHIP_STATUS_LABELS[value] }));

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).slice(0, 2);
  return parts.map((part) => part[0]?.toUpperCase() ?? "").join("") || "?";
}

function avatarTint(id: string): string {
  // Six quiet tints keyed on the id's last hex nibble, so a person keeps the
  // same colour across pages and reloads without another column.
  const tints = [
    "bg-avatar-1 text-avatar-1-ink",
    "bg-avatar-2 text-avatar-2-ink",
    "bg-avatar-3 text-avatar-3-ink",
    "bg-avatar-4 text-avatar-4-ink",
    "bg-avatar-5 text-avatar-5-ink",
    "bg-avatar-6 text-avatar-6-ink",
  ];
  const nibble = parseInt(id.slice(-1), 16);
  return tints[Number.isFinite(nibble) ? nibble % tints.length : 0];
}

async function ContactDetail({ id }: { id: string | undefined }) {
  const auth = await getAuthContext();
  const [detail, allCompanies] = await Promise.all([
    id ? getContactDetail(auth, { contactId: id }) : Promise.resolve(null),
    // The edit form's picker needs every company, not just a visible page.
    listCompanies(auth),
  ]);
  const correspondence = detail ? await listCorrespondence(auth, { contactId: detail.contact.id }) : [];
  const researchCardSet = detail
    ? await latestProfileResearch(auth, { subjectType: "contact", subjectId: detail.contact.id })
    : null;
  return (
    <Screen
      title="People"
      actions={
        <Link href={BASE} className="text-body-dense font-medium underline-offset-4 hover:underline">
          Open people list
        </Link>
      }
    >
      {detail ? (
        <ContactDetailPanel
          detail={detail}
          companies={allCompanies.map((company) => ({ id: company.id, name: company.name }))}
          correspondence={correspondence}
          researchCardSet={researchCardSet}
        />
      ) : (
        <Empty
          title="Contact not found"
          description="This record link does not match a contact in this workspace. No other contact was selected."
          action={
            <Button asChild variant="outline">
              <Link href={BASE}>Open people list</Link>
            </Button>
          }
        />
      )}
    </Screen>
  );
}

async function People({ searchParams }: { searchParams: SearchParams }) {
  const query = await searchParams;
  await io();
  const rawId = Array.isArray(query.id) ? query.id[0] : query.id;
  if (rawId) return <ContactDetail id={/^[0-9a-fA-F-]{36}$/.test(rawId) ? rawId : undefined} />;
  const auth = await getAuthContext();
  const list = parseListParams(query, { filters: { status: RELATIONSHIP_STATUSES } });
  const status = list.filters.status as RelationshipStatus | undefined;

  const [page, counts, allCompanies, contactDuplicates, companyDuplicates] = await Promise.all([
    pagePeople(auth, { query: list.q, limit: list.pageSize, offset: offsetFor(list.page, list.pageSize) }),
    countPeopleByStatus(auth),
    listCompanies(auth),
    findContactDuplicates(auth),
    findCompanyDuplicates(auth),
  ]);
  redirectPastEnd(BASE, query, list.page, list.pageSize, page.total);

  const countFor = (value: string) =>
    value === "unknown" ? counts.unmatched : (counts.statuses.find((s) => s.value === value)?.total ?? 0);

  return (
    <Screen
      title="People"
      actions={
        <ImportDialog>
          <Button variant="outline">Import connections</Button>
        </ImportDialog>
      }
    >
      <ListToolbar
        searchPlaceholder="Search name or email"
        filters={[
          {
            key: "status",
            label: "Status",
            allLabel: "All statuses",
            options: STATUS_FILTERS,
          },
        ]}
      />

      <DuplicatesPanel contactGroups={contactDuplicates} companyGroups={companyDuplicates} />

      <details>
        <summary className="cursor-pointer text-body-dense font-medium focus-visible:outline-2 focus-visible:outline-ring">
          New contact
        </summary>
        <div className="mt-3">
          <ContactForm companies={allCompanies.map((company) => ({ id: company.id, name: company.name }))} />
        </div>
      </details>

      <nav aria-label="People filters" className="flex flex-wrap items-center gap-1">
        <FilterLink
          href={listHref(BASE, query, { status: undefined, page: undefined })}
          active={!status}
          label="All"
          count={page.total}
        />
        {STATUS_FILTERS.map((f) => (
          <FilterLink
            key={f.value}
            href={listHref(BASE, query, { status: f.value, page: undefined })}
            active={status === f.value}
            label={f.label}
            count={countFor(f.value)}
          />
        ))}
      </nav>

      <div className="panel min-w-0 overflow-hidden rounded-xl">
        <div className="overflow-x-auto">
          <table className="w-full text-body-dense">
            <thead>
              <tr className="border-b border-border">
                <th scope="col" className="text-muted-foreground px-4 py-2.5 text-left text-xs font-medium">
                  Name
                </th>
                <th
                  scope="col"
                  className="text-muted-foreground hidden px-4 py-2.5 text-left text-xs font-medium md:table-cell"
                >
                  Company
                </th>
                <th
                  scope="col"
                  className="text-muted-foreground hidden px-4 py-2.5 text-left text-xs font-medium lg:table-cell"
                >
                  Email
                </th>
                <th scope="col" className="text-muted-foreground px-4 py-2.5 text-left text-xs font-medium">
                  Status
                </th>
                <th
                  scope="col"
                  className="text-muted-foreground hidden px-4 py-2.5 text-right text-xs font-medium sm:table-cell"
                >
                  Last activity
                </th>
              </tr>
            </thead>
            <tbody>
              {page.items.map((person) => (
                <tr key={person.id} className="border-b border-border last:border-0 hover:bg-muted/40">
                  <td className="px-4 py-2.5">
                    <div className="flex items-center gap-3">
                      <span
                        aria-hidden
                        className={`inline-flex size-7 shrink-0 items-center justify-center rounded-full text-data font-medium ${avatarTint(person.id)}`}
                      >
                        {initials(person.displayName)}
                      </span>
                      <div className="min-w-0">
                        {person.crmContactId ? (
                          <Link
                            href={`${BASE}?id=${person.crmContactId}`}
                            className="block max-w-[16rem] truncate font-medium underline-offset-4 hover:underline"
                          >
                            {person.displayName}
                          </Link>
                        ) : (
                          <span className="block max-w-[16rem] truncate font-medium">{person.displayName}</span>
                        )}
                        {person.title ? (
                          <span className="text-muted-foreground block max-w-[16rem] truncate text-xs">
                            {person.title}
                          </span>
                        ) : null}
                      </div>
                    </div>
                  </td>
                  <td className="text-muted-foreground hidden max-w-[12rem] truncate px-4 py-2.5 md:table-cell">
                    {person.currentOrganizationName ?? "—"}
                  </td>
                  <td className="text-muted-foreground hidden max-w-[14rem] truncate px-4 py-2.5 lg:table-cell">
                    {person.email ?? "—"}
                  </td>
                  <td className="px-4 py-2.5">
                    <RelationshipStatusPill status={person.relationshipStatus} />
                  </td>
                  <td className="text-muted-foreground readout hidden px-4 py-2.5 text-right text-xs sm:table-cell">
                    {timeAgo(person.updatedAt)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {!page.items.length ? (
          <div className="p-4">
            <NoResults
              filtered={Boolean(list.q || status)}
              clearHref={listHref(BASE, query, { q: undefined, status: undefined, page: undefined })}
              emptyTitle="No people yet"
            />
          </div>
        ) : null}

        <div className="border-t border-border px-4 py-3">
          <Pagination basePath={BASE} raw={query} page={list.page} pageSize={list.pageSize} total={page.total} />
        </div>
      </div>
    </Screen>
  );
}

function FilterLink({ href, active, label, count }: { href: string; active: boolean; label: string; count: number }) {
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={`inline-flex h-8 items-center gap-2 rounded-md border px-2.5 text-body-dense outline-none focus-visible:ring-2 focus-visible:ring-ring ${
        active
          ? "border-border bg-muted font-medium"
          : "border-transparent text-muted-foreground hover:bg-muted/60 hover:text-foreground"
      }`}
    >
      {label}
      <span className="readout text-muted-foreground text-xs">{count}</span>
    </Link>
  );
}

export default function PeoplePage({ searchParams }: { searchParams: SearchParams }) {
  return (
    <Suspense
      fallback={
        <p role="status" className="p-6 text-body-dense text-muted-foreground">
          Loading people…
        </p>
      }
    >
      <People searchParams={searchParams} />
    </Suspense>
  );
}
