"use client";

import { useState, useTransition } from "react";
import { Loader2, Link2, Plus, RefreshCw, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Screen, Panel, Status, Empty } from "@/components/workspace/ui";
import type { SourceRow } from "@/domains/knowledge/source-readiness";
import { addSource, importSources, retrySource, searchSources } from "./actions";

/*
 * The source-discovery surface (NotebookLM parity, S2). Four ways in: search
 * and import, paste a link, paste a video, and retry anything stuck. Everything
 * that fetches is queued; this panel only ever reports what the queue says.
 *
 * Readiness comes from the server projection in source-readiness.ts. The panel
 * never infers a state from a spinner: if the queue worker is not running, the
 * row says so after two minutes instead of spinning forever.
 */

const READINESS_LABEL: Record<SourceRow["readiness"], string> = {
  queued: "Queued",
  extracting: "Reading",
  embedding: "Indexing",
  ready: "Ready",
  failed: "Failed",
  unsupported: "Unsupported",
};

type SearchResult = { title: string; url: string; snippet: string };

export default function SourcesSurface({ initialSources }: { initialSources: SourceRow[] }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [pasteUrl, setPasteUrl] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [busy, startTransition] = useTransition();

  function announce(text: string) {
    setMessage(text);
  }

  function runSearch() {
    announce("");
    startTransition(async () => {
      const out = await searchSources(query);
      setResults(out.results);
      setSelected(new Set());
      if (out.error) announce(out.error);
      else if (out.results.length === 0) announce("No results. Try different words, or paste a link.");
    });
  }

  function runImport() {
    announce("");
    startTransition(async () => {
      const out = await importSources([...selected]);
      announce(out.error ?? `${out.imported} source(s) queued. They appear below as they land.`);
      setSelected(new Set());
    });
  }

  function runPaste() {
    if (!pasteUrl.trim()) return;
    announce("");
    startTransition(async () => {
      const out = await addSource(pasteUrl);
      announce(out.message);
      if (out.ok) setPasteUrl("");
    });
  }

  function runRetry(documentId: string) {
    announce("");
    startTransition(async () => {
      const out = await retrySource(documentId);
      announce(out.message);
    });
  }

  function toggle(url: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(url)) next.delete(url);
      else next.add(url);
      return next;
    });
  }

  return (
    <Screen
      title="Sources"
    >
      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_360px]">
        <Panel title="Find sources">
          <form
            className="flex flex-wrap items-end gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              runSearch();
            }}
          >
            <Input
              aria-label="Search for sources"
              className="h-9 min-w-0 flex-1 text-[13px]"
              placeholder="A topic, a paper title, a question"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <Button type="submit" disabled={busy || !query.trim()}>
              {busy ? <Loader2 aria-hidden className="animate-spin" /> : <Search aria-hidden />}
              Search
            </Button>
          </form>

          {results.length > 0 && (
            <div className="mt-4">
              <ul className="divide-y divide-border">
                {results.map((result) => (
                  <li key={result.url} className="flex items-start gap-3 py-3">
                    <input
                      aria-label={`Select ${result.title}`}
                      className="mt-1"
                      type="checkbox"
                      checked={selected.has(result.url)}
                      onChange={() => toggle(result.url)}
                    />
                    <div className="min-w-0">
                      <p className="truncate text-[13px] font-medium">{result.title || result.url}</p>
                      <p className="truncate text-xs text-muted-foreground">{result.url}</p>
                      {result.snippet && (
                        <p className="mt-1 line-clamp-2 text-[13px] leading-relaxed text-muted-foreground">{result.snippet}</p>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
              <div className="mt-3 flex items-center gap-2">
                <Button onClick={runImport} disabled={busy || selected.size === 0}>
                  <Plus aria-hidden />
                  Import {selected.size > 0 ? `${selected.size} ` : ""}selected
                </Button>
                <span className="text-xs text-muted-foreground">Queued, not fetched. They land in the list below.</span>
              </div>
            </div>
          )}
        </Panel>

        <div className="flex flex-col gap-6">
          <Panel title="Paste a link">
            <form
              className="flex flex-col gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                runPaste();
              }}
            >
              <Input
                aria-label="Paste a link"
                className="h-9 text-[13px]"
                placeholder="https:// or a YouTube link"
                value={pasteUrl}
                onChange={(e) => setPasteUrl(e.target.value)}
              />
              <Button type="submit" variant="outline" disabled={busy || !pasteUrl.trim()}>
                <Link2 aria-hidden />
                Add source
              </Button>
            </form>
            <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
              A YouTube link becomes one source, whatever form the link takes. Its transcript is fetched in the queue and
              timestamps are kept for citations.
            </p>
          </Panel>

          <Panel title="How to read this list">
            <dl className="space-y-2 text-[13px]">
              <div className="flex justify-between gap-3"><dt className="text-muted-foreground">Queued</dt><dd>Waiting for the queue worker</dd></div>
              <div className="flex justify-between gap-3"><dt className="text-muted-foreground">Reading</dt><dd>Extraction running</dd></div>
              <div className="flex justify-between gap-3"><dt className="text-muted-foreground">Indexing</dt><dd>Embedding for search</dd></div>
              <div className="flex justify-between gap-3"><dt className="text-muted-foreground">Ready</dt><dd>Searchable and citable</dd></div>
            </dl>
          </Panel>
        </div>
      </div>

      {message && (
        <p role="status" className="text-[13px] text-muted-foreground">
          {message}
        </p>
      )}

      <Panel title="Your sources" description="A stuck row names the reason instead of spinning.">
        {initialSources.length === 0 ? (
          <Empty
            title="No sources yet"
          />
        ) : (
          <ul className="divide-y divide-border">
            {initialSources.map((source) => (
              <li key={source.documentId} className="flex flex-wrap items-center gap-3 py-3">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[13px] font-medium">{source.title}</p>
                  <p className="truncate text-xs text-muted-foreground">
                    {source.kind === "video" ? "Video" : "Document"}
                    {source.sourceUrl ? ` · ${source.sourceUrl}` : ""}
                  </p>
                  {source.detail && <p className="mt-1 text-xs text-muted-foreground">{source.detail}</p>}
                </div>
                <Status>{READINESS_LABEL[source.readiness]}</Status>
                {(source.readiness === "failed" || source.readiness === "queued") && (
                  <Button size="sm" variant="outline" onClick={() => runRetry(source.documentId)} disabled={busy}>
                    <RefreshCw aria-hidden />
                    Retry
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </Screen>
  );
}
