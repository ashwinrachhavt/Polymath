import { io } from "next/cache";
import { Suspense } from "react";
import { redirectPastEnd } from "@/components/list/clamp";
import { ListToolbar } from "@/components/list/list-toolbar";
import { NoResults } from "@/components/list/no-results";
import { Pagination } from "@/components/list/pagination";
import Link from "next/link";
import { Empty, Panel, Screen, Status } from "@/components/workspace/ui";
import { pageCompanies } from "@/domains/crm/queries";
import { CompanyForm } from "../company-form";
import { ResearchCompanyButton } from "../research-button";
import { pageOrganizations } from "@/domains/identity/party-queries";
import { getAuthContext } from "@/lib/auth";
import { listHref, offsetFor, parseListParams, parsePageNumber } from "@/lib/list-params";
import { timeAgo } from "@/lib/time";

export const metadata = { title: "Companies · Polymath" };

/*
 * The Companies table over identity organizations — the employer records the
 * LinkedIn CSV import creates by matching the CSV's Company column. People
 * counts come from current party_employment edges at render.
 */

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

const BASE = "/command-center/relationships/companies";

async function Companies({ searchParams }: { searchParams: SearchParams }) {
  const query = await searchParams;
  await io();
  const auth = await getAuthContext();
  const list = parseListParams(query);
  const crmPage = parsePageNumber(query.cpage);
  const [page, companyPageData] = await Promise.all([
    pageOrganizations(auth, {
      query: list.q,
      limit: list.pageSize,
      offset: offsetFor(list.page, list.pageSize),
    }),
    pageCompanies(auth, { limit: list.pageSize, offset: offsetFor(crmPage, list.pageSize) }),
  ]);
  redirectPastEnd(BASE, query, list.page, list.pageSize, page.total);
  redirectPastEnd(BASE, query, crmPage, list.pageSize, companyPageData.total, "cpage");

  return (
    <Screen title="Companies">
      <ListToolbar searchPlaceholder="Search name or domain" />

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
                  Domain
                </th>
                <th scope="col" className="text-muted-foreground px-4 py-2.5 text-right text-xs font-medium">
                  People
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
              {page.items.map((company) => (
                <tr key={company.id} className="border-b border-border last:border-0 hover:bg-muted/40">
                  <td className="px-4 py-2.5">
                    <span className="block max-w-[18rem] truncate font-medium">{company.name}</span>
                  </td>
                  <td className="text-muted-foreground readout hidden px-4 py-2.5 text-xs md:table-cell">
                    {company.domain ?? "—"}
                  </td>
                  <td className="readout px-4 py-2.5 text-right">{company.peopleCount}</td>
                  <td className="text-muted-foreground readout hidden px-4 py-2.5 text-right text-xs sm:table-cell">
                    {timeAgo(company.updatedAt)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {!page.items.length ? (
          <div className="p-4">
            {list.q ? (
              <NoResults
                filtered
                clearHref={listHref(BASE, query, { q: undefined, page: undefined })}
                emptyTitle="No matches"
                emptyDescription="No company fits the current search."
              />
            ) : (
              <Empty title="No companies yet" />
            )}
          </div>
        ) : null}

        <div className="border-t border-border px-4 py-3">
          <Pagination basePath={BASE} raw={query} page={list.page} pageSize={list.pageSize} total={page.total} />
        </div>
      </div>

      <Panel title={`${companyPageData.total} ${companyPageData.total === 1 ? "company" : "companies"}`}>
        <div className="mb-4">
          <CompanyForm />
        </div>
        <div className="divide-y divide-border">
          {companyPageData.items.map((company) => (
            <div key={company.id} className="flex flex-wrap items-center justify-between gap-3 py-3 first:pt-0">
              <div>
                <Link
                  href={`/command-center/relationships/companies/${company.id}`}
                  className="text-body-dense font-medium underline-offset-4 hover:underline"
                >
                  {company.name}
                </Link>
                <p className="text-xs text-muted-foreground">{company.domain || "No domain recorded"}</p>
              </div>
              <div className="flex flex-wrap items-center gap-3">
                <Status>
                  {company.contactCount} current contact{company.contactCount === 1 ? "" : "s"}
                </Status>
                <ResearchCompanyButton companyId={company.id} />
              </div>
            </div>
          ))}
        </div>
        {!companyPageData.items.length ? <Empty title="No companies yet" /> : null}
        <Pagination
          basePath="/command-center/relationships/companies"
          raw={query}
          page={crmPage}
          pageSize={list.pageSize}
          total={companyPageData.total}
          pageParam="cpage"
        />
      </Panel>
    </Screen>
  );
}

export default function CompaniesPage({ searchParams }: { searchParams: SearchParams }) {
  return (
    <Suspense
      fallback={
        <p role="status" className="p-6 text-body-dense text-muted-foreground">
          Loading companies…
        </p>
      }
    >
      <Companies searchParams={searchParams} />
    </Suspense>
  );
}
