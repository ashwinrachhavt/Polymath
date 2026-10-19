import { EmptyState } from "@/components/empty-state";
import { fieldLabel, fieldValueText } from "./field-display";
import { PageHeader, Section } from "@/components/page-header";
import { Readout } from "@/components/readout";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { sentenceCase, suggestTitle } from "@/domains/knowledge/naming";
import {
  countDocumentInbox,
  getDocumentInbox,
  INBOX_KINDS,
  INBOX_READ_STATES,
  getDocumentReview,
  type DocumentReviewParty,
} from "@/domains/knowledge/queries";
import { resolvePartyCandidates } from "@/domains/knowledge/parties";
import { searchDocuments } from "@/domains/knowledge/search";
import { Suspense } from "react";
import { connection } from "next/server";
import { Skeleton } from "@/components/ui/skeleton";
import {
  CheckCircle2,
  Circle,
  CircleAlert,
  LoaderCircle,
  TriangleAlert,
} from "lucide-react";
import { getAuthContext } from "@/lib/auth";
import { redirectPastEnd } from "@/components/list/clamp";
import { ListToolbar } from "@/components/list/list-toolbar";
import { NoResults } from "@/components/list/no-results";
import { Pagination } from "@/components/list/pagination";
import { listHref, offsetFor, parseListParams, type RawSearchParams } from "@/lib/list-params";
import { ApplyTitleButton, ClassificationDecisions, FieldDecisions, ObligationDecisions, PartyDecisions, ProposeZettelsButton, ZettelDecisions } from "./decision-buttons";
import { listZettelProposals } from "@/domains/knowledge/zettels";
import { RetryExtractionButton } from "./retry-extraction-button";
import { RetryCaptureButton } from "./retry-capture-button";
import { documentStatus, type DocumentStatusTone } from "@/domains/knowledge/status";
import { RULES_PROPOSER } from "@/domains/knowledge/field-rules";
import { getOpenClassification } from "@/domains/knowledge/classify";
import { CaptureUrlForm } from "./capture-url-form";
import { UploadButton } from "./upload-button";

export const metadata = { title: "Knowledge · Axiom" };

/*
 * Notes, documents, sources, and flashcards. The document inbox is the live
 * half of this screen: files arrive, get read, and wait for the owner's
 * per-item decisions in the review workbench (?doc=<id>, server-rendered).
 */

const toneGlyph: Record<DocumentStatusTone, React.ReactNode> = {
  neutral: <Circle className="size-3 text-muted-foreground" aria-hidden />,
  progress: <LoaderCircle className="text-muted-foreground size-3" aria-hidden />,
  attention: <TriangleAlert className="size-3 text-amber-600 dark:text-amber-400" aria-hidden />,
  done: <CheckCircle2 className="size-3 text-teal-600 dark:text-teal-400" aria-hidden />,
  error: <CircleAlert className="text-destructive size-3" aria-hidden />,
};

const toneClass: Record<DocumentStatusTone, string> = {
  neutral: "text-muted-foreground",
  progress: "text-muted-foreground",
  attention: "text-amber-700 dark:text-amber-400",
  done: "text-teal-700 dark:text-teal-400",
  error: "text-destructive",
};

function StatusBadge({ label, tone }: { label: string; tone: DocumentStatusTone }) {
  return (
    <span className={`inline-flex items-center gap-1 text-xs font-medium ${toneClass[tone]}`}>
      {toneGlyph[tone]}
      <span>{label}</span>
    </span>
  );
}

function pageDomain(sourceUrl: string | null): string {
  if (!sourceUrl) return "page";
  try {
    return new URL(sourceUrl).hostname;
  } catch {
    return "page";
  }
}

const fetchedDate = new Intl.DateTimeFormat("en", { month: "short", day: "numeric", year: "numeric" });

/** The inbox row's second line: a page shows where it came from, a file shows what it is. */
function rowSubtitle(doc: { kind: "web_page" | "file"; sourceUrl: string | null; fetchedAt: Date | null; filename: string | null; mimeType: string | null }): string {
  if (doc.kind === "web_page") {
    const fetched = doc.fetchedAt ? ` · Fetched ${fetchedDate.format(doc.fetchedAt)}` : "";
    return `Web page · ${pageDomain(doc.sourceUrl)}${fetched}`;
  }
  return `${doc.filename ?? "No file"} · ${mimeTypeLabel(doc.mimeType)}`;
}

function mimeTypeLabel(mimeType: string | null): string {
  if (!mimeType) return "Unknown type";
  const known: Record<string, string> = {
    "application/pdf": "PDF",
    "image/png": "PNG",
    "image/jpeg": "JPEG",
    "text/markdown": "Web page",
  };
  return known[mimeType] ?? mimeType;
}

export async function KnowledgeSurface({
  searchParams,
}: {
  searchParams: Promise<RawSearchParams>;
}) {
  // Per-request data; streams inside the Suspense boundary below.
  await connection();
  if (!process.env.DATABASE_URL?.trim()) {
    return (
      <>
        <PageHeader title="Knowledge" purpose="Write, retrieve, and connect." />
        <div className="px-4 py-5 md:px-6">
          <EmptyState
            title="Knowledge storage is not configured"
            description="Set DATABASE_URL and apply the database migrations to upload and review documents. Extraction also requires private Blob storage (BLOB_READ_WRITE_TOKEN, or Vercel OIDC with BLOB_STORE_ID) and DOCLING_SERVE_URL or LLAMAPARSE_API_KEY."
          />
        </div>
      </>
    );
  }
  const auth = await getAuthContext();
  const raw = await searchParams;
  const params = { doc: typeof raw.doc === "string" ? raw.doc : undefined };
  // The search box above queries content (full text + semantic); the toolbar
  // below narrows the document list itself. Different keys so neither clobbers the other.
  const query = typeof raw.q === "string" ? raw.q.trim() || undefined : undefined;
  const list = parseListParams(raw, { filters: { kind: INBOX_KINDS, read: INBOX_READ_STATES }, qKey: "dq" });
  const inboxInput = {
    query: list.q || undefined,
    kind: list.filters.kind as (typeof INBOX_KINDS)[number] | undefined,
    readState: list.filters.read as (typeof INBOX_READ_STATES)[number] | undefined,
  };
  const inboxFiltered = Boolean(inboxInput.query || inboxInput.kind || inboxInput.readState);
  const inboxTotal = await countDocumentInbox(auth, inboxInput);
  redirectPastEnd("/alfred/knowledge", raw, list.page, list.pageSize, inboxTotal);
  const [inbox, review, partyOptions, searchHits] = await Promise.all([
    getDocumentInbox(auth, { ...inboxInput, limit: list.pageSize, offset: offsetFor(list.page, list.pageSize) }),
    params.doc ? getDocumentReview(auth, { documentId: params.doc }) : Promise.resolve(null),
    params.doc
      ? resolvePartyCandidates(auth, { documentId: params.doc }).catch(() => [])
      : Promise.resolve([]),
    query ? searchDocuments(auth, { query }) : Promise.resolve(null),
  ]);

  const selected = review;
  const optionsByParty = new Map(partyOptions.map((o) => [o.partyId, o.options]));
  const classification = selected ? await getOpenClassification(auth, selected.document.id) : null;
  const suggestedTitle = selected
    ? suggestTitle(
        selected.document.docType ?? classification?.proposedType ?? "",
        Object.fromEntries(
          selected.fieldProposals
            .filter((p) => p.status === "accepted" && (p.acceptedValue ?? p.normalizedValue) != null)
            .map((p) => [
              p.fieldName,
              typeof (p.acceptedValue ?? p.normalizedValue) === "string"
                ? String(p.acceptedValue ?? p.normalizedValue)
                : JSON.stringify(p.acceptedValue ?? p.normalizedValue),
            ]),
        ),
      )
    : null;

  return (
    <>
      <PageHeader
        title="Knowledge"
        purpose="Write, retrieve, and connect."
        actions={
          <>
            <UploadButton />
            <CaptureUrlForm />
            <Button variant="outline" disabled>
              Import
            </Button>
            <Button disabled>New note</Button>
          </>
        }
      />

      <div className="flex flex-col gap-6 px-4 py-5 md:px-6">
        <Section title="Search" description="Exact, full text, and semantic — one box.">
          <form action="/alfred/knowledge" method="get" className="flex gap-2">
            <label htmlFor="search" className="sr-only">
              Search knowledge
            </label>
            <input
              id="search"
              name="q"
              type="search"
              defaultValue={query ?? ""}
              placeholder="Search notes, documents, sources, and claims"
              className="border-input bg-background focus-visible:ring-ring min-w-0 flex-1 rounded-md border px-3 py-2 text-[13px] outline-none focus-visible:ring-3"
            />
            <Button type="submit" variant="outline">
              Search
            </Button>
          </form>
          {searchHits ? (
            searchHits.length === 0 ? (
              <p className="text-muted-foreground text-xs">
                Nothing matched “{query}”. Try a word from the document or its filename.
              </p>
            ) : (
              <ul className="flex flex-col gap-1.5">
                {searchHits.map((hit) => (
                  <li key={hit.id} className="text-[13px]">
                    <a
                      href={`/alfred/knowledge?doc=${hit.id}`}
                      className="font-medium underline-offset-4 hover:underline"
                    >
                      {hit.title}
                    </a>
                    <span className="text-muted-foreground">
                      {hit.filename ? ` · ${hit.filename}` : ""}
                    </span>
                    {hit.snippet ? <Snippet text={hit.snippet} /> : null}
                  </li>
                ))}
              </ul>
            )
          ) : null}
        </Section>

        <Section
          title="Documents"
          description="Files arrive, get read, and wait for your per-item decisions. Nothing is filed until you file it."
        >
          {!selected && (inboxTotal > 0 || inboxFiltered) ? (
            <ListToolbar
              qKey="dq"
              searchPlaceholder="Filter documents by title or file"
              filters={[
                { key: "kind", label: "Type", allLabel: "All types", options: [{ value: "file", label: "Files" }, { value: "web_page", label: "Web pages" }] },
                { key: "read", label: "Reading", allLabel: "Any state", options: [{ value: "unread", label: "Not read yet" }, { value: "failed", label: "Failed" }] },
              ]}
              total={inboxTotal}
              noun={inboxTotal === 1 ? "document" : "documents"}
            />
          ) : null}
          {inbox.length === 0 ? (
            <NoResults
              filtered={inboxFiltered}
              clearHref={listHref("/alfred/knowledge", raw, { dq: undefined, kind: undefined, read: undefined, page: undefined })}
              emptyTitle="No documents yet"
              emptyDescription="Upload a PDF or image and it appears here. Axiom reads it, proposes the fields, and you decide each one."
            />
          ) : selected ? (
            <ReviewWorkbench
              review={selected}
              zettels={await listZettelProposals(auth, selected.document.id)}
              partyOptions={optionsByParty}
              suggestedTitle={
                suggestedTitle && suggestedTitle !== selected.document.title ? suggestedTitle : null
              }
              classification={classification}
            />
          ) : (
            <ul className="flex flex-col gap-2">
              {inbox.map((doc) => {
                const status = documentStatus(
                  doc.extractionStatus
                    ? { status: doc.extractionStatus, proposalStatus: doc.proposalStatus }
                    : null,
                  doc.undecidedProposals,
                );
                return (
                  <li key={doc.id} className="panel rounded-lg px-3.5 py-3 transition-colors hover:bg-muted/40">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex min-w-0 flex-col gap-0.5">
                        <a
                          href={`/alfred/knowledge?doc=${doc.id}`}
                          className="text-[13px] font-medium underline-offset-4 hover:underline"
                        >
                          {doc.title}
                        </a>
                        <p className="text-muted-foreground truncate text-xs">
                          {rowSubtitle(doc)}
                          {doc.partyNames.length > 0 ? ` · ${doc.partyNames.join(", ")}` : ""}
                        </p>
                      </div>
                      <div className="flex items-center gap-2">
                        {/* A row that never got read heals from the inbox: a
                            page re-fetches on the same document, a file re-runs
                            the idempotent extraction route. */}
                        {doc.kind === "web_page" && !doc.fetchedAt ? (
                          <RetryCaptureButton url={doc.sourceUrl!} />
                        ) : doc.extractionStatus === null || doc.extractionStatus === "failed" ? (
                          <RetryExtractionButton
                            documentId={doc.id}
                            label={doc.extractionStatus === null ? "Read now" : "Retry"}
                          />
                        ) : null}
                        <StatusBadge label={status.label} tone={status.tone} />
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
          {!selected ? (
            <Pagination basePath="/alfred/knowledge" raw={raw} page={list.page} pageSize={list.pageSize} total={inboxTotal} />
          ) : null}
        </Section>

        <div className="grid gap-6 lg:grid-cols-2">
          <Section title="Sources" description="Where a claim came from, with the exact passage.">
            <EmptyState
              title="No sources yet"
              description="Pages, files, and messages become sources once something cites them."
            />
          </Section>

          <Section title="Learning" description="Separate from writing: what you are trying to retain.">
            <EmptyState
              title="No cards yet"
              description="Flashcards and quizzes are proposed from your own material, and only scheduled once you approve them."
              action={<Badge variant="outline"><Readout>0 due</Readout></Badge>}
            />
          </Section>
        </div>
      </div>
    </>
  );
}

/** Three zones: document info on the left, field and party decisions center, obligations right. */
function ReviewWorkbench({
  review,
  partyOptions,
  suggestedTitle,
  classification,
  zettels,
}: {
  zettels: Awaited<ReturnType<typeof listZettelProposals>>;
  review: NonNullable<Awaited<ReturnType<typeof getDocumentReview>>>;
  partyOptions: Map<string, { kind: "contact" | "company"; id: string; name: string; via: string }[]>;
  suggestedTitle: string | null;
  classification: Awaited<ReturnType<typeof getOpenClassification>> | null;
}) {
  const { document: doc, extraction, fieldProposals, parties, obligations } = review;
  const status = documentStatus(extraction, fieldProposals.filter((p) => p.status === "proposed").length);
  const undecided = fieldProposals.filter((p) => p.status === "proposed");

  return (
    <div className="flex flex-col gap-4">
      <a href="/alfred/knowledge" className="text-muted-foreground w-fit text-xs underline-offset-4 hover:underline">
        Back to inbox
      </a>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)_minmax(0,1.5fr)]">
        {/* Left: document info */}
        <div className="flex flex-col gap-3">
          <div className="panel rounded-lg px-3.5 py-3 transition-colors hover:bg-muted/40">
            <h3 className="text-[13px] font-medium">{doc.title}</h3>
            <p className="text-muted-foreground mt-1 text-xs">
              {doc.sourceUrl ? (
                <>
                  {"Web page · "}
                  <a href={doc.sourceUrl} target="_blank" rel="noreferrer" className="underline-offset-4 hover:underline">
                    {pageDomain(doc.sourceUrl)}
                  </a>
                </>
              ) : (
                mimeTypeLabel(doc.mimeType)
              )}
            </p>
            <div className="mt-2">
              <StatusBadge label={status.label} tone={status.tone} />
            </div>
            {extraction?.status === "failed" && extraction.error ? (
              <p role="alert" className="text-destructive mt-2 text-xs">
                {extraction.error}
              </p>
            ) : null}
            {extraction?.status === "succeeded" && extraction.proposalStatus === "failed" && extraction.proposalError ? (
              <p role="alert" className="text-destructive mt-2 text-xs">
                {extraction.proposalError}
              </p>
            ) : null}
            {extraction?.status === "succeeded" && extraction.proposalStatus === null ? (
              <p className="text-muted-foreground mt-2 text-xs">
                The text was read, but no fields have been proposed from it yet.
              </p>
            ) : null}
            {extraction?.status === "pending" || extraction === null ? (
              <p className="text-muted-foreground mt-2 text-xs">
                {extraction === null
                  ? "The file has not been read yet."
                  : "The document is being read."}
              </p>
            ) : null}
          </div>
          {extraction === null || extraction.status === "failed" ? (
            <RetryExtractionButton documentId={doc.id} label={extraction === null ? "Read now" : "Retry"} />
          ) : extraction.status === "succeeded" &&
            (extraction.proposalStatus === null || extraction.proposalStatus === "failed") ? (
            <RetryExtractionButton
              documentId={doc.id}
              label={extraction.proposalStatus === null ? "Propose fields" : "Retry proposing fields"}
            />
          ) : null}
          {doc.docType ? (
            <p className="text-muted-foreground text-xs">
              Classified as <span className="font-medium text-foreground">{doc.docType}</span>.
            </p>
          ) : classification ? (
            <ClassificationDecisions
              proposalId={classification.id}
              proposedType={classification.proposedType}
              confidence={classification.confidence}
              signals={classification.signals}
              expectedVersion={classification.version}
            />
          ) : null}
          {suggestedTitle ? (
            <ApplyTitleButton
              documentId={doc.id}
              title={suggestedTitle}
              expectedVersion={doc.version}
            />
          ) : null}
        </div>

        {/* Center: field proposals and parties */}
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-3">
            <h3 className="text-[13px] font-medium">Extracted fields</h3>
            {extraction?.proposer === RULES_PROPOSER && fieldProposals.length > 0 ? (
              <p className="text-muted-foreground text-xs">
                Proposed by text rules, not AI. Check each value against the line it was read from.
              </p>
            ) : null}
            {undecided.length === 0 && fieldProposals.length === 0 ? (
              <p className="text-muted-foreground text-xs">
                {extraction?.status === "succeeded"
                  ? "Nothing was extracted — the document had no readable fields."
                  : "Fields appear here once the document is read."}
              </p>
            ) : (
              <ul className="flex flex-col gap-2">
                {fieldProposals.map((proposal) => (
                  <li key={proposal.id} className="panel rounded-lg px-3.5 py-3 transition-colors hover:bg-muted/40">
                    <p className="text-[13px] font-medium">{sentenceCase(fieldLabel(proposal.fieldName))}</p>
                    {proposal.evidenceQuote ? (
                      <p className="text-muted-foreground mt-0.5 text-xs">
                        Read from: <q className="text-foreground">{proposal.evidenceQuote}</q>
                      </p>
                    ) : null}
                    <p className="text-muted-foreground mt-0.5 text-xs">
                      {proposal.partyRole ? `About the ${proposal.partyRole}. ` : ""}
                      {proposal.confidence ? `Confidence: ${proposal.confidence}.` : ""}
                    </p>
                    <p className="text-muted-foreground mt-0.5 text-xs">
                      Reads as{" "}
                      <span className="text-foreground">{fieldValueText(proposal.normalizedValue, proposal.normalizationNote)}</span>
                      {proposal.rawValue && proposal.rawValue !== fieldValueText(proposal.normalizedValue, proposal.normalizationNote)
                        ? ` (written “${proposal.rawValue}”)`
                        : ""}
                    </p>
                    {proposal.status === "proposed" ? (
                      <div className="mt-2">
                        <FieldDecisions
                          proposalId={proposal.id}
                          fieldName={fieldLabel(proposal.fieldName)}
                          readable={proposal.normalizedValue != null}
                        />
                      </div>
                    ) : (
                      <p className="text-muted-foreground mt-1 text-xs">
                        {proposal.status === "accepted" ? "Accepted" : "Rejected"}
                        {proposal.acceptedValue != null
                          ? ` — ${typeof proposal.acceptedValue === "string" ? proposal.acceptedValue : JSON.stringify(proposal.acceptedValue)}`
                          : ""}
                      </p>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>

          <Parties parties={parties} optionsByParty={partyOptions} />
        </div>

        {/* Right: obligations */}
        <div className="flex flex-col gap-3">
          <h3 className="text-[13px] font-medium">Proposed follow-up work</h3>
          {obligations.length === 0 ? (
            <p className="text-muted-foreground text-xs">
              Nothing proposed — no unpaid totals or missing fields were found.
            </p>
          ) : (
            <ul className="flex flex-col gap-2">
              {obligations.map((obligation) => (
                <li key={obligation.id} className="panel rounded-lg px-3.5 py-3 transition-colors hover:bg-muted/40">
                  <p className="text-[13px]">{obligation.note ?? obligation.kind}</p>
                  {obligation.status === "proposed" ? (
                    <div className="mt-2">
                      <ObligationDecisions obligationId={obligation.id} />
                    </div>
                  ) : (
                    <p className="text-muted-foreground mt-1 text-xs">
                      {obligation.status === "accepted"
                        ? "Accepted — a task was created."
                        : obligation.status === "rejected"
                          ? "Rejected"
                          : "Superseded by a newer document"}
                    </p>
                  )}
                </li>
              ))}
            </ul>
          )}

          <h3 className="mt-2 text-[13px] font-medium">Proposed zettels</h3>
          {extraction?.status === "succeeded" ? <ProposeZettelsButton documentId={doc.id} /> : null}
          {zettels.length === 0 ? (
            <p className="text-muted-foreground text-xs">No zettels proposed yet.</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {zettels.map((z) => (
                <li key={z.id} className="panel rounded-lg px-3.5 py-3 transition-colors hover:bg-muted/40">
                  <p className="text-[13px] font-medium">{z.title}</p>
                  <p className="text-[13px]">{z.claim}</p>
                  <p className="text-muted-foreground mt-1 line-clamp-2 text-xs">
                    &ldquo;{z.quote}&rdquo; · chars {z.spanStart}-{z.spanEnd}
                  </p>
                  {z.status === "proposed" ? (
                    <div className="mt-2">
                      <ZettelDecisions proposalId={z.id} />
                    </div>
                  ) : (
                    <p className="text-muted-foreground mt-1 text-xs">
                      {z.status === "accepted" ? "Accepted. Concept and evidence link written." : "Rejected"}
                    </p>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

/** A search passage with the matched words marked; ts_headline wraps them in [[ ]]. */
function Snippet({ text }: { text: string }) {
  return (
    <p className="text-muted-foreground mt-0.5 text-xs">
      {text.split(/(\[\[.*?\]\])/).map((part, index) =>
        part.startsWith("[[") && part.endsWith("]]") ? (
          <mark key={index} className="text-foreground bg-transparent font-medium underline underline-offset-2">
            {part.slice(2, -2)}
          </mark>
        ) : (
          <span key={index}>{part}</span>
        ),
      )}
    </p>
  );
}

function Parties({
  parties,
  optionsByParty,
}: {
  parties: DocumentReviewParty[];
  optionsByParty: Map<string, { kind: "contact" | "company"; id: string; name: string; via: string }[]>;
}) {
  if (parties.length === 0) {
    return (
      <div className="flex flex-col gap-2">
        <h3 className="text-[13px] font-medium">People and companies</h3>
        <p className="text-muted-foreground text-xs">None were found in this document.</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-[13px] font-medium">People and companies</h3>
      <ul className="flex flex-col gap-2">
        {parties.map((party) => (
          <li key={party.id} className="panel rounded-lg px-3.5 py-3 transition-colors hover:bg-muted/40">
            <p className="text-[13px] font-medium">
              {party.displayName}{" "}
              <span className="text-muted-foreground font-normal">
                · {sentenceCase(party.partyRole)}
              </span>
            </p>
            {party.resolutionStatus === "unresolved" ? (
              <div className="mt-2">
                <PartyDecisions
                  partyId={party.id}
                  displayName={party.displayName}
                  partyKind={party.partyKind}
                  options={optionsByParty.get(party.id) ?? []}
                />
              </div>
            ) : (
              <p className="text-muted-foreground mt-1 text-xs">
                {party.resolutionStatus === "matched" || party.resolutionStatus === "created"
                  ? `Linked to ${(party.contactName ?? party.companyName) ?? "a record"}`
                  : "Marked as not part of this document"}
              </p>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

export default function KnowledgePage({
  searchParams,
}: {
  searchParams: Promise<RawSearchParams>;
}) {
  return (
    <Suspense fallback={<KnowledgeSkeleton />}>
      <KnowledgeSurface searchParams={searchParams} />
    </Suspense>
  );
}

function KnowledgeSkeleton() {
  return (
    <div role="status" aria-label="Loading Knowledge" className="flex flex-1 flex-col gap-4 p-6">
      <Skeleton className="h-6 w-40" />
      <Skeleton className="h-4 w-full max-w-xl" />
      <div className="grid gap-3 md:grid-cols-2">
        <Skeleton className="h-40" />
        <Skeleton className="h-40" />
      </div>
    </div>
  );
}
