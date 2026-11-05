import Link from "next/link";
import { Suspense } from "react";
import { io } from "next/cache";
import { Skeleton } from "@/components/ui/skeleton";
import { Panel, Screen } from "@/components/workspace/ui";
import { getNote, listNoteSources, listNoteTags, type NoteDetail } from "@/domains/knowledge/notes";
import { linkedNotes, mergeIdeaLinks, relatedNotes, type RelatedNote } from "@/domains/knowledge/relations";
import { pageZettelCards } from "@/domains/knowledge/zettels";
import { IdeaGrid, type IdeaView } from "@/components/polymath/ideas/idea-grid";
import { IdeaModal } from "@/components/polymath/ideas/idea-modal";
import { blocksOf } from "@/components/polymath/ideas/idea-blocks";
import { getAuthContext } from "@/lib/auth";
import { destinations } from "@/lib/navigation";
import { redirectPastEnd } from "@/components/list/clamp";
import { ListToolbar } from "@/components/list/list-toolbar";
import { NoResults } from "@/components/list/no-results";
import { Pagination } from "@/components/list/pagination";
import { listHref, offsetFor, parseListParams, type RawSearchParams } from "@/lib/list-params";

export const metadata = { title: "Ideas · Polymath" };

/*
 * The Ideas surface: every saved idea, read through the four views the old
 * zettel collection offered. One read, many projections — cards, table,
 * timeline and dictionary are sorts over the same rows, so the count, the
 * tags and the titles can never disagree between them. An idea opens as a
 * modal card over this collection (`?idea=<id>`): creating one was a single
 * action, and reading one is too — the browser's back button closes it.
 */

const BASE = "/polymath/ideas";
const VIEWS = ["cards", "table", "timeline", "dictionary"] as const;
const FALLBACK_PURPOSE = "Your ideas, each with its evidence.";
// The rail owns this copy; read it there so the page and the rail agree.
const purpose = () => destinations.find((destination) => destination.href === BASE)?.purpose ?? FALLBACK_PURPOSE;

const stamp = (d: Date) => d.toLocaleDateString("en", { month: "short", day: "numeric" });

function ViewTabs({ view, raw }: { view: IdeaView; raw: RawSearchParams }) {
  return (
    <div className="mb-3 flex flex-wrap items-center gap-2" role="tablist" aria-label="Idea views">
      {VIEWS.map((candidate) => (
        <Link
          key={candidate}
          role="tab"
          aria-selected={view === candidate}
          href={listHref(BASE, raw, { view: candidate === "cards" ? undefined : candidate, page: undefined })}
          className={`rounded-full border px-3 py-1 text-xs capitalize ${view === candidate ? "border-foreground/40 bg-muted/70" : "border-border hover:bg-muted/40"}`}
        >
          {candidate}
        </Link>
      ))}
    </div>
  );
}

function TagFilter({ tags, tag, raw }: { tags: string[]; tag: string | undefined; raw: RawSearchParams }) {
  if (tags.length === 0) return null;
  return (
    <div className="mb-3 flex flex-wrap gap-1" aria-label="Filter by tag">
      {tags.map((candidate) => (
        <Link
          key={candidate}
          href={listHref(BASE, raw, { tag: tag === candidate ? undefined : candidate, page: undefined })}
          aria-pressed={tag === candidate}
          className={`rounded-full border px-2 py-0.5 text-xs ${tag === candidate ? "border-foreground/40 bg-muted/70" : "border-border hover:bg-muted/40"}`}
        >
          {candidate}
        </Link>
      ))}
    </div>
  );
}

function Tags({ tags }: { tags: string[] }) {
  if (tags.length === 0) return null;
  return (
    <span className="flex flex-wrap gap-1">
      {tags.map((tag) => (
        <span key={tag} className="pill pill-neutral">
          {tag}
        </span>
      ))}
    </span>
  );
}

/*
 * The card's reading body: the claim as paragraphs, the evidence as a
 * blockquote, one "Linked ideas" list (explicit and semantic edges merged,
 * each a plain link — there is no decision to make about a link), the
 * document it was decomposed from, and timestamps. Blocks render in document
 * order, and a body longer than one paragraph keeps every paragraph.
 */
function IdeaCardBody({
  idea,
  linked,
  sources,
  ideaHref,
}: {
  idea: NoteDetail;
  linked: RelatedNote[];
  sources: { id: string; title: string | null; context: string | null }[];
  ideaHref: (id: string) => string;
}) {
  const blocks = blocksOf(idea.content);
  return (
    <article className="flex flex-col gap-4">
      {blocks.map((block, index) =>
        block.quote ? (
          <blockquote
            key={index}
            className="border-l-2 border-border pl-3 text-body-dense leading-relaxed text-muted-foreground"
          >
            {block.text}
          </blockquote>
        ) : (
          <p key={index} className="text-body leading-relaxed">
            {block.text}
          </p>
        ),
      )}
      <Tags tags={idea.tags} />
      {linked.length > 0 ? (
        <section className="flex flex-col gap-1">
          <h2 className="text-body-dense font-medium">Linked ideas</h2>
          <ul className="flex flex-col gap-1">
            {linked.map((card) => (
              <li key={card.id}>
                <Link href={ideaHref(card.id)} className="text-body-dense underline-offset-2 hover:underline">
                  {card.title}
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {sources.length > 0 ? (
        <p className="text-xs text-muted-foreground">
          From{" "}
          {sources.map((source, index) => (
            <span key={source.id}>
              {index > 0 ? " · " : null}
              <Link
                href={`/polymath/knowledge?doc=${encodeURIComponent(source.id)}`}
                className="underline underline-offset-2"
              >
                {source.title || "Untitled document"}
              </Link>
            </span>
          ))}
        </p>
      ) : null}
      <p className="text-xs text-muted-foreground">
        Added {stamp(idea.createdAt)} · updated {stamp(idea.updatedAt)}
      </p>
    </article>
  );
}

export async function IdeasSurface({ searchParams }: { searchParams: Promise<RawSearchParams> }) {
  await io();
  const auth = await getAuthContext();
  const raw = await searchParams;
  const list = parseListParams(raw, { defaultPageSize: 24 });
  const requested = typeof raw.view === "string" ? raw.view : "";
  const view: IdeaView = (VIEWS as readonly string[]).includes(requested) ? (requested as IdeaView) : "cards";
  const tag = typeof raw.tag === "string" && raw.tag.trim() ? raw.tag.trim().toLowerCase() : undefined;
  const ideaParam = typeof raw.idea === "string" && raw.idea.trim() ? raw.idea.trim() : undefined;
  // The two reads are independent given the workspace; resolve them in one
  // wave and gate the page-end redirect on the page's total afterwards (spec W2).
  const [found, allTags] = await Promise.all([
    pageZettelCards(auth, {
      query: list.q,
      tag,
      limit: list.pageSize,
      offset: offsetFor(list.page, list.pageSize),
      // The dictionary view reads alphabetically and the others newest-first;
      // the ordering has to be the query's, or page 2 starts the alphabet again.
      sort: view === "dictionary" ? "title" : "recent",
    }),
    listNoteTags(auth),
  ]);
  redirectPastEnd(BASE, raw, list.page, list.pageSize, found.total);
  const filtered = Boolean(list.q || tag);

  // The modal's card, fetched on the server so a deep link renders the full
  // card in one pass. A malformed, archived, foreign or missing id all read
  // as null — one honest miss inside the modal, with the way back attached.
  const selected = ideaParam ? await getNote(auth, ideaParam) : null;
  let sources: { id: string; title: string | null; context: string | null }[] = [];
  let linked: RelatedNote[] = [];
  if (selected) {
    const [sourceRows, explicit, semantic] = await Promise.all([
      listNoteSources(auth, selected.id),
      linkedNotes(auth, selected.id),
      relatedNotes(auth, selected.id),
    ]);
    sources = sourceRows;
    linked = mergeIdeaLinks(explicit, semantic);
  }
  const closeHref = listHref(BASE, raw, { idea: undefined });
  const ideaHref = (id: string) => listHref(BASE, raw, { idea: id });

  return (
    <Screen title="Ideas" description={purpose()}>
      <Panel>
        <ViewTabs view={view} raw={raw} />
        <div className="mb-3">
          <ListToolbar searchPlaceholder="Search ideas" />
        </div>
        <TagFilter tags={allTags} tag={tag} raw={raw} />
        {found.items.length === 0 && filtered ? (
          <NoResults
            filtered
            clearHref={listHref(BASE, raw, { q: undefined, tag: undefined, page: undefined })}
            emptyTitle=""
            emptyDescription=""
          />
        ) : (
          <IdeaGrid items={found.items} view={view} baseHref={BASE} raw={raw} />
        )}
        <Pagination basePath={BASE} raw={raw} page={list.page} pageSize={list.pageSize} total={found.total} compact />
        {ideaParam ? (
          <IdeaModal
            key={selected?.id ?? "missing"}
            title={selected?.title ?? "Idea not found"}
            closeHref={closeHref}
            editor={
              selected
                ? {
                    workspaceId: auth.workspaceId,
                    artifactId: selected.id,
                    version: selected.version,
                    initialContent: selected.draft?.content ?? selected.content ?? undefined,
                  }
                : null
            }
          >
            {selected ? (
              <IdeaCardBody idea={selected} linked={linked} sources={sources} ideaHref={ideaHref} />
            ) : (
              <p className="text-body-dense text-muted-foreground">
                This idea could not be found. It may have been removed, or it belongs to another workspace.
              </p>
            )}
          </IdeaModal>
        ) : null}
      </Panel>
    </Screen>
  );
}

export default function IdeasPage(props: { searchParams: Promise<RawSearchParams> }) {
  return (
    <Suspense
      fallback={
        <div role="status" aria-label="Loading ideas" className="flex flex-1 flex-col gap-4 p-6">
          <Skeleton className="h-6 w-40" />
          <Skeleton className="h-4 w-full max-w-xl" />
          <Skeleton className="h-40" />
        </div>
      }
    >
      <IdeasSurface {...props} />
    </Suspense>
  );
}
