import Link from "next/link";
import { Suspense } from "react";
import { connection } from "next/server";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/empty-state";
import { PageHeader, Section } from "@/components/page-header";
import { getAuthContext } from "@/lib/auth";
import { redirectPastEnd } from "@/components/list/clamp";
import { ListToolbar } from "@/components/list/list-toolbar";
import { NoResults } from "@/components/list/no-results";
import { Pagination } from "@/components/list/pagination";
import { listHref, matchesQuery, paginate, parseListParams, parsePageNumber, type RawSearchParams } from "@/lib/list-params";
import { getDossierDetail, listAttachableDocuments, listDossierRuns, listDossiers } from "@/domains/knowledge/dossiers";
import { draftsForRuns, getDraftDetail } from "@/domains/knowledge/studio";
import { DraftControls } from "../draft-controls";
import { Badge } from "@/components/ui/badge";
import { CreateDossierForm } from "./create-dossier-form";
import { DraftWorkbench } from "./draft-workbench";
import { listLinkableRecords, resolveLinkTitles } from "./links";
import { GenerateForm } from "./generate-form";
import { ResearchCompanyForm } from "./research-form";

export const metadata = { title: "Dossiers · Polymath" };

/*
 * The dossier screen: the workspace's dossiers, the documents each one holds,
 * and Studio Generate bound to a dossier. All of it reads Neon; nothing here
 * is the browser preview.
 */
// Per-request data; streams inside the Suspense boundary in the default export.
const BASE = "/alfred/dossiers";

export async function DossiersSurface({
  searchParams,
}: {
  searchParams: Promise<RawSearchParams>;
}) {
  await connection();
  if (!process.env.DATABASE_URL?.trim()) {
    return (
      <>
        <PageHeader title="Dossiers" purpose="Named sets of documents an agent works inside." />
        <div className="page-content">
          <EmptyState
            title="Dossier storage is not configured"
            description="Set DATABASE_URL and apply the database migrations to create dossiers and generate from them."
          />
        </div>
      </>
    );
  }
  const auth = await getAuthContext();
  const raw = await searchParams;
  const params = {
    dossier: typeof raw.dossier === "string" ? raw.dossier : undefined,
    draft: typeof raw.draft === "string" ? raw.draft : undefined,
  };
  const list = parseListParams(raw, { filters: { contents: ["with", "empty"] }, defaultPageSize: 10 });
  const [dossiers, attachable, detail] = await Promise.all([
    listDossiers(auth),
    listAttachableDocuments(auth),
    params.dossier ? getDossierDetail(auth, params.dossier) : Promise.resolve(null),
  ]);
  const matching = dossiers.filter(
    (d) =>
      matchesQuery(list.q, d.title) &&
      (!list.filters.contents || (list.filters.contents === "with" ? d.documentCount > 0 : d.documentCount === 0)),
  );
  redirectPastEnd(BASE, raw, list.page, list.pageSize, matching.length);
  const dossierPage = paginate(matching, list.page, list.pageSize);
  const docsPageNumber = parsePageNumber(raw.dpage);
  const docsPaged = detail ? paginate(detail.documents, docsPageNumber, 25) : null;
  if (detail) redirectPastEnd(BASE, raw, docsPageNumber, 25, detail.documents.length, "dpage");
  const dossierRuns = detail ? await listDossierRuns(auth, detail.id) : [];
  const dossierRunDrafts = await draftsForRuns(auth, dossierRuns.map((run) => run.id));
  const draftDetail = params.draft ? await getDraftDetail(auth, params.draft) : null;
  const [linkTitles, linkable] = draftDetail
    ? await Promise.all([resolveLinkTitles(auth, draftDetail.links), listLinkableRecords(auth)])
    : [null, null];

  return (
    <>
      <PageHeader title="Dossiers" purpose="Named sets of documents an agent works inside." />
      <div className="flex flex-col gap-8 page-content">
        <Section title="Your dossiers" description="A dossier scopes search and generation to the documents pinned inside it.">
          {dossiers.length === 0 ? (
            <EmptyState
              title="No dossiers yet"
              description="Create one below, attach the documents it should cover, then generate a draft that stays inside those documents."
            />
          ) : (
            <>
            {dossiers.length > 4 || list.q || list.filters.contents ? (
              <ListToolbar
                pageKeys={["page"]}
                searchPlaceholder="Search dossiers"
                filters={[
                  { key: "contents", label: "Contents", allLabel: "All dossiers", options: [{ value: "with", label: "Has documents" }, { value: "empty", label: "Empty" }] },
                ]}
                total={matching.length}
                noun={matching.length === 1 ? "dossier" : "dossiers"}
              />
            ) : null}
            {matching.length === 0 ? (
              <NoResults
                filtered
                clearHref={listHref(BASE, raw, { q: undefined, contents: undefined, page: undefined })}
                emptyTitle=""
                emptyDescription=""
              />
            ) : null}
            <ul className="flex flex-col gap-1">
              {dossierPage.items.map((dossier) => (
                <li key={dossier.id}>
                  <a
                    href={listHref(BASE, raw, { dossier: dossier.id, dpage: undefined, draft: undefined })}
                    className={`flex items-baseline gap-2 rounded-md px-2 py-1.5 text-[13px] hover:bg-accent ${detail?.id === dossier.id ? "bg-accent" : ""}`}
                  >
                    <span className="font-medium">{dossier.title}</span>
                    <span className="text-muted-foreground">
                      {dossier.documentCount} {dossier.documentCount === 1 ? "document" : "documents"}
                    </span>
                  </a>
                  <Link
                    href={`/alfred/dossiers/${dossier.id}/notebook`}
                    className="ml-2 text-xs text-muted-foreground underline-offset-2 hover:underline"
                  >
                    Open notebook
                  </Link>
                </li>
              ))}
            </ul>
            <Pagination basePath={BASE} raw={raw} page={dossierPage.page} pageSize={list.pageSize} total={matching.length} />
            </>
          )}
        </Section>

        {detail ? (
          <Section title={detail.title} description="The documents this dossier holds, each pinned at the version it was attached at.">
            {detail.documents.length === 0 ? (
              <p className="text-muted-foreground text-[13px]">No documents yet. Create a dossier with documents, or ask the assistant to attach them.</p>
            ) : (
              <ul className="flex flex-col gap-1">
                {docsPaged!.items.map((doc) => (
                  <li key={doc.id} className="flex items-baseline gap-2 px-2 py-1 text-[13px]">
                    <span>{doc.title}</span>
                    <span className="text-muted-foreground">{doc.mimeType ?? "unfiled"}</span>
                  </li>
                ))}
              </ul>
            )}
            <Pagination basePath={BASE} raw={raw} page={docsPaged!.page} pageSize={25} total={detail.documents.length} pageParam="dpage" compact />
            <Section title="Research a company" description="An evidence-grounded case study that reads only this dossier's pinned sources - no web search, gaps marked honestly.">
              <ResearchCompanyForm dossierId={detail.id} />
            </Section>
            <Section title="Generate a draft" description="Starts a run that reads only this dossier. The result is a draft you save or discard; nothing publishes.">
              <GenerateForm dossierId={detail.id} />
              {dossierRuns.length > 0 ? (
                <ul className="mt-3 flex flex-col gap-2">
                  {dossierRuns.map((run) => (
                    <li key={run.id} className="flex flex-col gap-1 rounded-md border border-border px-3 py-2">
                      <div className="flex items-baseline justify-between gap-2">
                        <p className="line-clamp-1 text-[13px]">{run.objective}</p>
                        <Badge variant="secondary" className="font-normal">{run.state === "waiting_input" ? "Answered" : run.state}</Badge>
                      </div>
                      <DraftControls runId={run.id} draft={dossierRunDrafts.get(run.id) ?? null} canSave={run.state === "succeeded" || run.state === "waiting_input"} />
                      {dossierRunDrafts.get(run.id) ? (
                        <a
                          href={`/alfred/dossiers?dossier=${detail.id}&draft=${dossierRunDrafts.get(run.id)?.artifactId}`}
                          className="w-fit text-muted-foreground text-xs underline underline-offset-2 hover:text-foreground"
                        >
                          Open the workbench
                        </a>
                      ) : null}
                    </li>
                  ))}
                </ul>
              ) : null}
            </Section>
          </Section>
        ) : null}

        {draftDetail && linkTitles && linkable ? (
          <Section title="Draft workbench" description="Read the draft with the documents it stands on, edit it into a new version, and attach it to the record it informs.">
            <DraftWorkbench
              artifact={draftDetail.artifact}
              text={draftDetail.text}
              sources={draftDetail.sources}
              links={draftDetail.links}
              linkTitles={linkTitles}
              linkable={linkable}
            />
          </Section>
        ) : null}

        <Section title="New dossier" description="Pick the documents it should cover. You can attach more later.">
          <CreateDossierForm documents={attachable} />
        </Section>
      </div>
    </>
  );
}

export default function DossiersPage(props: { searchParams: Promise<RawSearchParams> }) {
  return (
    <Suspense fallback={<DossiersSkeleton />}>
      <DossiersSurface {...props} />
    </Suspense>
  );
}

function DossiersSkeleton() {
  return (
    <div role="status" aria-label="Loading Dossiers" className="flex flex-1 flex-col gap-4 p-6">
      <Skeleton className="h-6 w-40" />
      <Skeleton className="h-4 w-full max-w-xl" />
      <Skeleton className="h-40" />
    </div>
  );
}
