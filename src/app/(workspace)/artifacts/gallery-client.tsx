"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { FileText, LayoutGrid, List, Search } from "lucide-react";
import { WriteFromLibrary } from "./write-from-library";

/*
 * Gallery toolbar (filter tabs, search, grid/list toggle) and the artifact
 * preview card. All of it navigates; the page is the only fetcher.
 */

export function GalleryToolbar({
  currentView,
  query,
}: {
  currentView: string;
  query: string;
}) {
  const router = useRouter();
  const params = useSearchParams();
  const [draft, setDraft] = useState(query);

  function navigate(patch: Record<string, string | undefined>) {
    const next = new URLSearchParams(params.toString());
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined || value === "") next.delete(key);
      else next.set(key, value);
    }
    router.push(`/artifacts?${next.toString()}`);
  }

  return (
    <div className="flex items-center gap-3">
      <form
        role="search"
        onSubmit={(event) => {
          event.preventDefault();
          navigate({ q: draft || undefined });
        }}
      >
        <label className="sr-only" htmlFor="artifact-search">Search artifacts</label>
        <div className="flex h-8 items-center gap-1.5 rounded-md border border-border px-2">
          <Search aria-hidden className="size-3.5 text-muted-foreground" />
          <input
            id="artifact-search"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder="Search"
            className="w-32 bg-transparent text-[13px] outline-none"
          />
        </div>
      </form>
      <WriteFromLibrary />
      <div className="flex items-center rounded-md border border-border" role="group" aria-label="Layout">
        <button
          type="button"
          aria-label="Grid view"
          aria-pressed={currentView === "grid"}
          className={`p-1.5 ${currentView === "grid" ? "bg-muted" : ""}`}
          onClick={() => navigate({ view: "grid" })}
        >
          <LayoutGrid aria-hidden className="size-4" />
        </button>
        <button
          type="button"
          aria-label="List view"
          aria-pressed={currentView === "list"}
          className={`p-1.5 ${currentView === "list" ? "bg-muted" : ""}`}
          onClick={() => navigate({ view: "list" })}
        >
          <List aria-hidden className="size-4" />
        </button>
      </div>
    </div>
  );
}

export function ArtifactCard({ artifact, view }: { artifact: { id: string; title: string; kind: string; preview: string }; view: string }) {
  const isList = view === "list";
  return (
    <Link
      href={`/artifacts/${artifact.id}`}
      className={`group block rounded-xl border border-border p-4 transition-colors hover:bg-muted/40 ${isList ? "flex items-center gap-4" : ""}`}
    >
      <div className={isList ? "min-w-0 flex-1" : ""}>
        <p className={`text-muted-foreground/70 leading-snug ${isList ? "line-clamp-2 text-[13px]" : "line-clamp-6 font-serif text-[13px]"}`}>
          {artifact.preview || "Empty artifact."}
        </p>
      </div>
      <div className={`mt-3 flex items-center gap-2 ${isList ? "mt-0 shrink-0" : ""}`}>
        <FileText aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="truncate text-[13px]">{artifact.title}</span>
        <span className="text-xs text-muted-foreground">{artifact.kind}</span>
      </div>
    </Link>
  );
}
