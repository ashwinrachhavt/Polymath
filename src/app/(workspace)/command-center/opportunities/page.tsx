import { connection } from "next/server";
import Link from "next/link";
import { Suspense } from "react";
import { Button } from "@/components/ui/button";
import { Empty, Panel, Screen, Status } from "@/components/workspace/ui";
import { listCompanies, listContacts } from "@/domains/crm/queries";
import {
  getOpportunityDetail,
  listOpportunities,
  OPPORTUNITY_STAGES,
  PIPELINE_STAGES,
  STAGE_LABELS,
  type OpportunityStage,
} from "@/domains/opportunities/queries";
import { getAuthContext } from "@/lib/auth";
import { redirectPastEnd } from "@/components/list/clamp";
import { ListToolbar } from "@/components/list/list-toolbar";
import { NoResults } from "@/components/list/no-results";
import { Pagination } from "@/components/list/pagination";
import { listHref, paginate, parseListParams, parsePageNumber } from "@/lib/list-params";
import { OpportunityForm } from "./opportunity-form";
import { ResearchOpportunityButton } from "./research-button";
import {
  ArchiveOpportunityButton,
  DeadlineForm,
  MarkDeadlineMetButton,
  StageSelect,
} from "./opportunity-controls";

export const metadata = { title: "Opportunities · Axiom" };

/*
 * Canonical pipeline (ASH-139 C02): opportunities read from Postgres, stage
 * changes recorded in append-only history. Stage is human-reported tracking -
 * selecting "submitted" records that the owner says it was submitted; nothing
 * submits anything. The browser-preview store that used to render here is
 * retired for this domain.
 */

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

async function Opportunities({ searchParams }: { searchParams: SearchParams }) {
  const query = await searchParams;
  await connection();
  const auth = await getAuthContext();
  const list = parseListParams(query, { filters: { stage: OPPORTUNITY_STAGES } });
  const q = list.q || undefined;
  const stage = list.filters.stage as OpportunityStage | undefined;
  const closedPage = parsePageNumber(query.cpage);
  const rawId = first(query.id);
  const selectedId = rawId && /^[0-9a-fA-F-]{36}$/.test(rawId) ? rawId : undefined;
  const invalidSelection = !!rawId && !selectedId;

  const [records, companies, contacts, detail] = await Promise.all([
    listOpportunities(auth, { query: q, stage }),
    listCompanies(auth),
    listContacts(auth),
    selectedId ? getOpportunityDetail(auth, { opportunityId: selectedId }) : Promise.resolve(null),
  ]);

  const companyOptions = companies.map((company) => ({ id: company.id, name: company.name }));
  const contactOptions = contacts.items.map((contact) => ({ id: contact.id, name: contact.fullName }));
  const open = records.filter((record) => (PIPELINE_STAGES as readonly string[]).includes(record.stage));
  const closedAll = records.filter((record) => !(PIPELINE_STAGES as readonly string[]).includes(record.stage));
  // The board shows every open card; only the long tail of closed ones is paged.
  redirectPastEnd("/command-center/opportunities", query, closedPage, list.pageSize, closedAll.length, "cpage");
  const closedPaged = paginate(closedAll, closedPage, list.pageSize);
  const closed = closedPaged.items;

  function card(record: (typeof records)[number]) {
    return (
      <div key={record.id} className="border-b border-border py-3 last:border-0">
        <Link
          href={`/command-center/opportunities?id=${record.id}`}
          className="text-[13px] font-medium underline-offset-4 hover:underline"
        >
          {record.title}
        </Link>
        <p className="my-1 text-xs text-muted-foreground">
          {record.companyName || "No company"}
          {record.primaryContactName ? ` · ${record.primaryContactName}` : ""}
        </p>
        {record.nextCommitment ? (
          <p className="mb-2 text-xs text-muted-foreground">
            Next: {record.nextCommitment}
            {record.nextCommitmentAt ? ` (${record.nextCommitmentAt.toISOString().slice(0, 10)})` : ""}
          </p>
        ) : null}
        <StageSelect opportunityId={record.id} stage={record.stage} version={record.version} />
      </div>
    );
  }

  return (
    <Screen
      title="Opportunities"
      description="A human-controlled pipeline for roles, leads and partnerships. Stage changes are recorded, never executed: nothing here submits an application or sends a message."
    >
      <ListToolbar
        searchPlaceholder="Search title or company"
        filters={[
          {
            key: "stage",
            label: "Stage",
            allLabel: "All stages",
            options: OPPORTUNITY_STAGES.map((value) => ({ value, label: STAGE_LABELS[value] })),
          },
        ]}
        total={records.length}
        noun={records.length === 1 ? "opportunity" : "opportunities"}
      />

      <details className="panel rounded-xl p-4">
        <summary className="cursor-pointer text-[13px] font-medium focus-visible:outline-2 focus-visible:outline-ring">
          New opportunity
        </summary>
        <div className="mt-3">
          <OpportunityForm companies={companyOptions} contacts={contactOptions} />
        </div>
      </details>

      <div className="grid gap-3 md:grid-cols-2 2xl:grid-cols-3">
        {PIPELINE_STAGES.map((pipelineStage) => (
          <Panel
            key={pipelineStage}
            title={STAGE_LABELS[pipelineStage]}
            actions={<Status>{open.filter((record) => record.stage === pipelineStage).length}</Status>}
          >
            <div>{open.filter((record) => record.stage === pipelineStage).map(card)}</div>
            {!open.some((record) => record.stage === pipelineStage) ? (
              <p className="text-xs text-muted-foreground">Nothing in this stage.</p>
            ) : null}
          </Panel>
        ))}
      </div>

      {closedAll.length ? (
        <Panel title={`Closed (${closedAll.length})`}>
          <div className="divide-y divide-border">
            {closed.map((record) => (
              <div key={record.id} className="flex flex-wrap items-center justify-between gap-3 py-3 first:pt-0">
                <div>
                  <Link
                    href={`/command-center/opportunities?id=${record.id}`}
                    className="text-[13px] font-medium underline-offset-4 hover:underline"
                  >
                    {record.title}
                  </Link>
                  <p className="text-xs text-muted-foreground">{record.companyName || "No company"}</p>
                </div>
                <Status>{STAGE_LABELS[record.stage]}</Status>
              </div>
            ))}
          </div>
          <Pagination
            basePath="/command-center/opportunities"
            raw={query}
            page={closedPaged.page}
            pageSize={list.pageSize}
            total={closedAll.length}
            pageParam="cpage"
          />
        </Panel>
      ) : null}

      {!records.length ? (
        <NoResults
          filtered={Boolean(q || stage)}
          clearHref={listHref("/command-center/opportunities", query, { q: undefined, stage: undefined, cpage: undefined })}
          emptyTitle="No opportunities yet"
          emptyDescription="Create an opportunity above to start the pipeline."
        />
      ) : null}

      <div>
        {invalidSelection ? (
          <Empty
            title="Opportunity not found"
            description="This record link is not a valid opportunity id. No opportunity was selected."
            action={
              <Button asChild variant="outline">
                <Link href="/command-center/opportunities">Open pipeline</Link>
              </Button>
            }
          />
        ) : selectedId && !detail ? (
          <Empty
            title="Opportunity not found"
            description="This record link does not match an opportunity in this workspace. No other opportunity was selected."
            action={
              <Button asChild variant="outline">
                <Link href="/command-center/opportunities">Open pipeline</Link>
              </Button>
            }
          />
        ) : detail ? (
          <Panel
            title={detail.opportunity.title}
            description={`${STAGE_LABELS[detail.opportunity.stage]} · outcome: ${detail.opportunity.outcome}`}
          >
            <dl className="mb-4 grid gap-2 text-[13px] sm:grid-cols-2">
              <div>
                <dt className="text-muted-foreground">Company</dt>
                <dd>{detail.companyName || "Not recorded"}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Primary contact</dt>
                <dd>{detail.primaryContactName || "Not recorded"}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Source</dt>
                <dd>{detail.opportunity.sourceType || "Not recorded"}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Next commitment</dt>
                <dd>
                  {detail.opportunity.nextCommitment || "None"}
                  {detail.opportunity.nextCommitmentAt
                    ? ` (${detail.opportunity.nextCommitmentAt.toISOString().slice(0, 10)})`
                    : ""}
                </dd>
              </div>
            </dl>
            <div className="mb-4">
              <ResearchOpportunityButton opportunityId={detail.opportunity.id} disabled={!detail.companyName} />
              {!detail.companyName ? (
                <p className="mt-1 text-xs text-muted-foreground">Record a company on this opportunity to research it.</p>
              ) : null}
            </div>
            {detail.opportunity.whyItMatters ? (
              <p className="mb-4 whitespace-pre-wrap text-[13px] leading-relaxed">
                {detail.opportunity.whyItMatters}
              </p>
            ) : null}
            <details className="mb-4">
              <summary className="cursor-pointer text-[13px] font-medium focus-visible:outline-2 focus-visible:outline-ring">
                Edit opportunity
              </summary>
              <div className="mt-3">
                <OpportunityForm
                  companies={companyOptions}
                  contacts={contactOptions}
                  opportunity={{
                    id: detail.opportunity.id,
                    version: detail.opportunity.version,
                    title: detail.opportunity.title,
                    companyId: detail.opportunity.companyId,
                    primaryContactId: detail.opportunity.primaryContactId,
                    whyItMatters: detail.opportunity.whyItMatters,
                    sourceType: detail.opportunity.sourceType,
                    nextCommitment: detail.opportunity.nextCommitment,
                    nextCommitmentOn: detail.opportunity.nextCommitmentAt
                      ? detail.opportunity.nextCommitmentAt.toISOString().slice(0, 10)
                      : null,
                  }}
                />
              </div>
            </details>

            <div className="mb-4">
              <p className="mb-2 text-xs font-medium text-muted-foreground">Stage history</p>
              <div className="space-y-1">
                {detail.history.map((row) => (
                  <p key={row.id} className="text-xs text-muted-foreground">
                    {row.fromStage ? `${STAGE_LABELS[row.fromStage]} → ` : ""}
                    {STAGE_LABELS[row.toStage]} · {row.createdAt.toISOString().slice(0, 10)}
                    {row.note ? ` — ${row.note}` : ""}
                  </p>
                ))}
              </div>
            </div>

            <div className="mb-4">
              <p className="mb-2 text-xs font-medium text-muted-foreground">Deadlines</p>
              <div className="mb-3 divide-y divide-border">
                {detail.deadlines.map((deadline) => (
                  <div key={deadline.id} className="flex flex-wrap items-center justify-between gap-3 py-2 first:pt-0">
                    <p className="text-[13px]">
                      {deadline.label}
                      <span className="ml-2 text-xs text-muted-foreground">
                        {deadline.dueOn || "no date"}
                        {deadline.metAt ? ` — met ${deadline.metAt.toISOString().slice(0, 10)}` : ""}
                      </span>
                    </p>
                    {!deadline.metAt ? (
                      <MarkDeadlineMetButton deadlineId={deadline.id} version={deadline.version} />
                    ) : null}
                  </div>
                ))}
              </div>
              <DeadlineForm opportunityId={detail.opportunity.id} />
            </div>

            <div className="border-t border-border pt-4">
              <ArchiveOpportunityButton
                opportunityId={detail.opportunity.id}
                version={detail.opportunity.version}
                title={detail.opportunity.title}
              />
            </div>
          </Panel>
        ) : null}
      </div>
    </Screen>
  );
}

export default function OpportunitiesPage({ searchParams }: { searchParams: SearchParams }) {
  return (
    <Suspense fallback={<p role="status" className="p-6 text-[13px] text-muted-foreground">Loading opportunities…</p>}>
      <Opportunities searchParams={searchParams} />
    </Suspense>
  );
}
