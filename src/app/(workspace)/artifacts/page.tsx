import { Suspense } from "react";
import { connection } from "next/server";
import { Skeleton } from "@/components/ui/skeleton";
import { getAuthContext } from "@/lib/auth";
import { listGalleryArtifacts, type GalleryArtifact } from "@/domains/knowledge/artifact-gallery";
import { ArtifactCard, GalleryToolbar } from "./gallery-client";

export const metadata = { title: "Artifacts · Polymath" };

/*
 * The artifact gallery (Perplexity parity): filter tabs, month grouping, and a
 * card grid where each card previews its content. Grid/list toggle and search
 * are the toolbar's.
 */

export async function ArtifactsSurface({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await connection();
  if (!process.env.DATABASE_URL?.trim()) {
    return (
      <div className="px-6 py-6 text-[13px] text-muted-foreground">
        Set DATABASE_URL and apply the database migrations to use the artifact gallery.
      </div>
    );
  }
  const auth = await getAuthContext();
  const raw = await searchParams;
  const filterRaw = typeof raw.filter === "string" ? raw.filter : "all";
  const origin = filterRaw === "run" || filterRaw === "upload" ? filterRaw : undefined;
  const query = typeof raw.q === "string" ? raw.q.trim() : "";
  const view = raw.view === "list" ? "list" : "grid";

  const { items: matching } = await listGalleryArtifacts(auth, { origin, query, limit: 200 });

  // Month groups, newest first: "October 2026".
  const groups = new Map<string, GalleryArtifact[]>();
  for (const item of matching) {
    const label = item.updatedAt.toLocaleString("en-US", { month: "long", year: "numeric" });
    const bucket = groups.get(label);
    if (bucket) bucket.push(item);
    else groups.set(label, [item]);
  }

  return (
    <>
      <div className="flex items-center justify-between gap-4 border-b border-border px-6 py-4">
        <h1 className="text-lg font-medium">Artifacts</h1>
      </div>
      {/* GalleryToolbar reads useSearchParams, which forces a CSR bailout for
          the whole page unless it sits inside a Suspense boundary. */}
      <Suspense fallback={null}>
        <GalleryToolbar currentView={view} query={query} />
      </Suspense>
      <div className="px-6 py-6">
        {matching.length === 0 ? (
          <p className="text-[13px] text-muted-foreground">
            Nothing here yet. Generate a draft from a project and it lands in this gallery.
          </p>
        ) : (
          [...groups.entries()].map(([label, group]) => (
            <section key={label} aria-label={label} className="mb-10">
              {/* The mockup's dotted passage rule: the month names the passage,
                  not a toolbar row. */}
              <div className="rule-label mb-5">{label}</div>
              <div className={view === "grid" ? "grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-6" : "flex flex-col gap-3"}>
                {group.map((item) => (
                  <ArtifactCard key={item.id} artifact={item} view={view} />
                ))}
              </div>
            </section>
          ))
        )}
      </div>
    </>
  );
}

export default async function ArtifactsPage(props: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  return (
    <Suspense fallback={<Skeleton className="m-6 h-64 w-full" />}>
      <ArtifactsSurface {...props} />
    </Suspense>
  );
}
