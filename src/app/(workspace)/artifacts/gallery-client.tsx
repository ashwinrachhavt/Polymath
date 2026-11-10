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
  currentFilter,
  currentKind,
  currentStatus,
  query,
}: {
  currentView: string;
  currentFilter: string;
  currentKind: string;
  currentStatus: string;
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
    <div className="flex flex-wrap items-center gap-3 px-6 py-3">
      <div className="flex items-center gap-1" role="group" aria-label="Artifact origin">
        {[
          { label: "All", value: "all" },
          { label: "Sources", value: "source" },
          { label: "Generated", value: "generated" },
        ].map((filter) => (
          <button
            key={filter.value}
            type="button"
            aria-pressed={currentFilter === filter.value}
            className={`rounded-md px-2.5 py-1.5 text-body-dense ${currentFilter === filter.value ? "bg-muted font-medium" : "text-muted-foreground hover:bg-muted/60"}`}
            onClick={() => navigate({ kind: undefined, filter: filter.value === "all" ? undefined : filter.value })}
          >
            {filter.label}
          </button>
        ))}
      </div>
      <label className="flex items-center gap-2 text-body-dense text-muted-foreground">
        <span>Kind</span>
        <select
          aria-label="Filter by kind"
          value={currentKind}
          onChange={(event) => {
            const value = event.target.value;
            navigate({ kind: value || undefined, filter: value === "source" ? "source" : undefined });
          }}
          className="h-8 rounded-md border border-border bg-background px-2 text-body-dense text-foreground"
        >
          <option value="">All kinds</option>
          {[
            "source",
            "note",
            "zettel",
            "document",
            "memo",
            "report",
            "diagram",
            "transcript",
            "deck",
            "infographic",
            "quiz",
            "flashcards",
            "other",
          ].map((kind) => (
            <option key={kind} value={kind}>
              {kind[0].toUpperCase() + kind.slice(1)}
            </option>
          ))}
        </select>
      </label>
      <label className="flex items-center gap-2 text-body-dense text-muted-foreground">
        <span>Status</span>
        <select
          aria-label="Filter by status"
          value={currentStatus}
          onChange={(event) => navigate({ status: event.target.value || undefined })}
          className="h-8 rounded-md border border-border bg-background px-2 text-body-dense text-foreground"
        >
          <option value="">All statuses</option>
          {["draft", "generated", "reviewed", "published", "pending", "succeeded", "failed", "skipped"].map(
            (status) => (
              <option key={status} value={status}>
                {status[0].toUpperCase() + status.slice(1)}
              </option>
            ),
          )}
        </select>
      </label>
      <form
        role="search"
        onSubmit={(event) => {
          event.preventDefault();
          navigate({ q: draft || undefined });
        }}
      >
        <label className="sr-only" htmlFor="artifact-search">
          Search sources and artifacts
        </label>
        <div className="flex h-8 items-center gap-1.5 rounded-md border border-border px-2">
          <Search aria-hidden className="size-3.5 text-muted-foreground" />
          <input
            id="artifact-search"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder="Search"
            className="w-32 bg-transparent text-body-dense outline-none"
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

export function ArtifactCard({
  artifact,
  view,
}: {
  artifact: {
    recordType: "artifact" | "source" | "quiz" | "flashcard_deck";
    id: string;
    title: string;
    kind: string;
    status: string;
    preview: string;
    notebookId?: string | null;
    documentId?: string | null;
  };
  view: string;
}) {
  const isList = view === "list";
  const href =
    artifact.recordType === "source"
      ? `/polymath/knowledge?doc=${artifact.id}`
      : artifact.recordType === "quiz"
        ? artifact.notebookId
          ? `/projects/${artifact.notebookId}/notebook?quiz=${artifact.id}`
          : `/learn/${artifact.documentId}`
        : artifact.recordType === "flashcard_deck"
          ? `/projects/${artifact.notebookId}/notebook/flashcards?deck=${artifact.id}`
          : `/artifacts/${artifact.id}`;
  const label = artifact.recordType === "source" ? "Source" : artifact.kind;
  return (
    <Link
      href={href}
      className={`group block rounded-xl border border-border p-4 transition-colors hover:bg-muted/40 ${isList ? "flex items-center gap-4" : ""}`}
    >
      <div className={isList ? "min-w-0 flex-1" : ""}>
        <p
          className={`text-muted-foreground/70 leading-snug ${isList ? "line-clamp-2 text-body-dense" : "line-clamp-6 font-serif text-body-dense"}`}
        >
          {artifact.preview || (artifact.recordType === "source" ? "No extracted text yet." : "Empty artifact.")}
        </p>
      </div>
      <div className={`mt-3 flex min-w-0 items-center gap-2 ${isList ? "mt-0 shrink-0" : ""}`}>
        <FileText aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="truncate text-body-dense">{artifact.title}</span>
        <span className="shrink-0 text-xs text-muted-foreground">{label}</span>
        <span className="shrink-0 text-xs text-muted-foreground">{artifact.status}</span>
      </div>
    </Link>
  );
}
