import Link from "next/link";
import { Suspense } from "react";
import { io } from "next/cache";
import { Skeleton } from "@/components/ui/skeleton";
import { Panel, Screen } from "@/components/workspace/ui";
import { listNoteTags } from "@/domains/knowledge/notes";
import { pageZettelCards } from "@/domains/knowledge/zettels";
import { IdeaGrid, type IdeaView } from "@/components/polymath/ideas/idea-grid";
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
 * tags and the titles can never disagree between them.
 */

const BASE = "/polymath/ideas";
const VIEWS = ["cards", "table", "timeline", "dictionary"] as const;
const FALLBACK_PURPOSE = "Your ideas, each with its evidence.";
// The rail owns this copy; read it there so the page and the rail agree.
const purpose = () => destinations.find((destination) => destination.href === BASE)?.purpose ?? FALLBACK_PURPOSE;

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

export async function IdeasSurface({ searchParams }: { searchParams: Promise<RawSearchParams> }) {
  await io();
  const auth = await getAuthContext();
  const raw = await searchParams;
  const list = parseListParams(raw, { defaultPageSize: 24 });
  const requested = typeof raw.view === "string" ? raw.view : "";
  const view: IdeaView = (VIEWS as readonly string[]).includes(requested) ? (requested as IdeaView) : "cards";
  const tag = typeof raw.tag === "string" && raw.tag.trim() ? raw.tag.trim().toLowerCase() : undefined;
  const found = await pageZettelCards(auth, {
    query: list.q,
    tag,
    limit: list.pageSize,
    offset: offsetFor(list.page, list.pageSize),
  });
  redirectPastEnd(BASE, raw, list.page, list.pageSize, found.total);
  const allTags = await listNoteTags(auth);
  const filtered = Boolean(list.q || tag);

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
          <IdeaGrid items={found.items} view={view} baseHref={BASE} />
        )}
        <Pagination basePath={BASE} raw={raw} page={list.page} pageSize={list.pageSize} total={found.total} compact />
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
