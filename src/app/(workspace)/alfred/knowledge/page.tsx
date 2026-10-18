import { EmptyState } from "@/components/empty-state";
import { PageHeader, Section } from "@/components/page-header";
import { Readout } from "@/components/readout";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { sentenceCase, suggestTitle } from "@/domains/knowledge/naming";
import {
  getDocumentInbox,
  getDocumentReview,
  type DocumentReviewParty,
} from "@/domains/knowledge/queries";
import { resolvePartyCandidates } from "@/domains/knowledge/parties";
import { searchDocuments } from "@/domains/knowledge/search";
import { connection } from "next/server";
import {
  CheckCircle2,
  Circle,
  CircleAlert,
  LoaderCircle,
  TriangleAlert,
} from "lucide-react";
import { getAuthContext } from "@/lib/auth";
import { ApplyTitleButton, FieldDecisions, ObligationDecisions, PartyDecisions } from "./decision-buttons";
import { RetryExtractionButton } from "./retry-extraction-button";
import { documentStatus, type DocumentStatusTone } from "@/domains/knowledge/status";
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

function mimeTypeLabel(mimeType: string | null): string {
  if (!mimeType) return "Unknown type";
  const known: Record<string, string> = {
    "application/pdf": "PDF",
    "image/png": "PNG",
    "image/jpeg": "JPEG",
  };
  return known[mimeType] ?? mimeType;
}

export default async function KnowledgePage({
  searchParams,
}: {
  searchParams: Promise<{ doc?: string; q?: string }>;
}) {
  // Per-request data; opt this route out of prerender.
  await connection();
  const auth = await getAuthContext();
  const params = await searchParams;
  const query = params.q?.trim();
  const [inbox, review, partyOptions, searchHits] = await Promise.all([
    getDocumentInbox(auth),
    params.doc ? getDocumentReview(auth, { documentId: params.doc }) : Promise.resolve(null),
    params.doc
      ? resolvePartyCandidates(auth, { documentId: params.doc }).catch(() => [])
      : Promise.resolve([]),
    query ? searchDocuments(auth, { query }) : Promise.resolve(null),
  ]);

  const selected = review;
  const optionsByParty = new Map(partyOptions.map((o) => [o.partyId, o.options]));
  const suggestedTitle = selected
    ? suggestTitle(
        "",
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
              defaultValue={params.q ?? ""}
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
          {inbox.length === 0 ? (
            <EmptyState
              title="No documents yet"
              description="Upload a PDF or image and it appears here. Axiom reads it, proposes the fields, and you decide each one."
              action={<UploadButton />}
            />
          ) : selected ? (
            <ReviewWorkbench
              review={selected}
              partyOptions={optionsByParty}
              suggestedTitle={
                suggestedTitle && suggestedTitle !== selected.document.title ? suggestedTitle : null
              }
            />
          ) : (
            <ul className="flex flex-col gap-2">
              {inbox.map((doc) => {
                const status = documentStatus(
                  doc.extractionStatus ? { status: doc.extractionStatus } : null,
                  doc.undecidedProposals,
                );
                return (
                  <li key={doc.id} className="panel rounded-lg px-3.5 py-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex min-w-0 flex-col gap-0.5">
                        <a
                          href={`/alfred/knowledge?doc=${doc.id}`}
                          className="text-[13px] font-medium underline-offset-4 hover:underline"
                        >
                          {doc.title}
                        </a>
                        <p className="text-muted-foreground truncate text-xs">
                          {doc.filename ?? "No file"} · {mimeTypeLabel(doc.mimeType)}
                          {doc.partyNames.length > 0 ? ` · ${doc.partyNames.join(", ")}` : ""}
                        </p>
                      </div>
                      <StatusBadge label={status.label} tone={status.tone} />
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
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
}: {
  review: NonNullable<Awaited<ReturnType<typeof getDocumentReview>>>;
  partyOptions: Map<string, { kind: "contact" | "company"; id: string; name: string; via: string }[]>;
  suggestedTitle: string | null;
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
          <div className="panel rounded-lg px-3.5 py-3">
            <h3 className="text-[13px] font-medium">{doc.title}</h3>
            <p className="text-muted-foreground mt-1 text-xs">
              {mimeTypeLabel(doc.mimeType)}
            </p>
            <div className="mt-2">
              <StatusBadge label={status.label} tone={status.tone} />
            </div>
            {extraction?.status === "failed" && extraction.error ? (
              <p role="alert" className="text-destructive mt-2 text-xs">
                {extraction.error}
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
            {undecided.length === 0 && fieldProposals.length === 0 ? (
              <p className="text-muted-foreground text-xs">
                {extraction?.status === "succeeded"
                  ? "Nothing was extracted — the document had no readable fields."
                  : "Fields appear here once the document is read."}
              </p>
            ) : (
              <ul className="flex flex-col gap-2">
                {fieldProposals.map((proposal) => (
                  <li key={proposal.id} className="panel rounded-lg px-3.5 py-3">
                    <p className="text-[13px] font-medium">{sentenceCase(proposal.fieldName.replace(/[_-]+/g, " "))}</p>
                    <p className="text-muted-foreground mt-0.5 text-xs">
                      Raw: {proposal.rawValue ?? "(nothing)"} · Normalized:{" "}
                      {proposal.normalizedValue == null
                        ? (proposal.normalizationNote ?? "unreadable")
                        : typeof proposal.normalizedValue === "string"
                          ? proposal.normalizedValue
                          : JSON.stringify(proposal.normalizedValue)}
                    </p>
                    {proposal.status === "proposed" ? (
                      <div className="mt-2">
                        <FieldDecisions
                          proposalId={proposal.id}
                          fieldName={proposal.fieldName}
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
                <li key={obligation.id} className="panel rounded-lg px-3.5 py-3">
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
        </div>
      </div>
    </div>
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
          <li key={party.id} className="panel rounded-lg px-3.5 py-3">
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
