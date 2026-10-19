"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { ExternalLink, Share2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Select } from "@/components/ui/select";
import { Readout } from "@/components/readout";
import { kindLabel, type BrowserRow } from "@/domains/knowledge/file-browser";
import type { DocumentPreview } from "@/domains/knowledge/file-preview";
import { PartyBlocks } from "./party-blocks";

type Tab = "details" | "evidence" | "activity";
type Load = { id: string; state: "loading" } | { id: string; state: "error" } | { id: string; state: "ready"; data: DocumentPreview };

const cache = new Map<string, DocumentPreview>();
const stamp = new Intl.DateTimeFormat("en", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

/*
 * The right-hand preview: what the document is, what was read from it with the
 * line each value came from, and what has happened to it. Fetched on
 * selection and cached for the session, so moving back to a row is instant.
 */
export function PreviewPane({
  row,
  folders,
  onMove,
  onTag,
  onUntag,
  onClose,
  onShare,
}: {
  row: BrowserRow;
  folders: Array<{ id: string; name: string }>;
  onMove: (folderId: string | null) => void;
  onTag: (tag: string) => Promise<boolean>;
  onUntag: (tag: string) => void;
  onClose: () => void;
  onShare: () => void;
}) {
  const [tagDraft, setTagDraft] = useState("");
  const [tab, setTab] = useState<Tab>("details");
  const [load, setLoad] = useState<Load>(() => {
    const hit = cache.get(row.id);
    return hit ? { id: row.id, state: "ready", data: hit } : { id: row.id, state: "loading" };
  });

  useEffect(() => {
    // The pane is keyed by row, so a cached row never needs a fetch.
    if (cache.has(row.id)) return;
    const controller = new AbortController();
    fetch(`/api/v1/documents/${row.id}/preview`, { signal: controller.signal })
      .then((r) => (r.ok ? (r.json() as Promise<DocumentPreview>) : Promise.reject(new Error(String(r.status)))))
      .then((data) => {
        cache.set(row.id, data);
        setLoad({ id: row.id, state: "ready", data });
      })
      .catch((error: unknown) => {
        if ((error as { name?: string }).name !== "AbortError") setLoad({ id: row.id, state: "error" });
      });
    return () => controller.abort();
  }, [row.id]);

  const data = load.id === row.id && load.state === "ready" ? load.data : null;
  const tabs: Array<[Tab, string]> = [
    ["details", "Details"],
    ["evidence", "Evidence"],
    ["activity", "Activity"],
  ];

  return (
    <aside aria-label="Preview" className="border-border bg-background flex w-full shrink-0 flex-col border-t md:w-[22rem] md:border-t-0 md:border-l">
      <div className="border-border flex items-start justify-between gap-2 border-b px-4 py-3">
        <div className="min-w-0">
          <h2 className="font-display truncate text-lg leading-tight">{row.title}</h2>
          <p className="text-muted-foreground truncate text-xs">
            {kindLabel(row)}
            {row.filename ? ` · ${row.filename}` : ""}
            {data ? ` · v${data.review.document.version}` : ""}
          </p>
        </div>
        <button type="button" aria-label="Close preview" onClick={onClose} className="hover:bg-muted rounded p-1">
          <X aria-hidden className="size-4" />
        </button>
      </div>
      <div className="border-border flex items-center gap-2 border-b px-4 py-2">
        <Button asChild size="sm">
          <Link href={`/alfred/library/${row.id}`}>Open</Link>
        </Button>
        <Button asChild size="sm" variant="outline">
          <Link href="/alfred/knowledge">Review fields</Link>
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onShare}>
          <Share2 aria-hidden className="size-3.5" /> Share
        </Button>
        {row.sourceUrl ? (
          <a href={row.sourceUrl} target="_blank" rel="noreferrer noopener" aria-label="Open original page" className="hover:bg-muted ml-auto rounded p-1.5">
            <ExternalLink aria-hidden className="size-4" />
          </a>
        ) : null}
      </div>
      <div role="tablist" aria-label="Preview sections" className="border-border flex gap-4 border-b px-4">
        {tabs.map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            onClick={() => setTab(id)}
            className={`-mb-px border-b-2 py-2 text-[13px] ${tab === id ? "border-foreground font-medium" : "text-muted-foreground border-transparent"}`}
          >
            {label}
          </button>
        ))}
      </div>
      <div role="tabpanel" className="flex flex-col gap-5 overflow-auto px-4 py-4 text-[13px]">
        {!data ? (
          <p role="status" className="text-muted-foreground">
            {load.id === row.id && load.state === "error" ? "Could not load this document." : "Loading…"}
          </p>
        ) : tab === "details" ? (
          <>
            <section className="flex flex-col gap-2">
              <label className="flex items-center justify-between gap-2">
                <span className="text-muted-foreground text-xs">Folder</span>
                <Select value={row.folderId ?? ""} onChange={(e) => onMove(e.target.value || null)} aria-label="Folder" className="w-44">
                  <option value="">Unfiled</option>
                  {folders.map((f) => (
                    <option key={f.id} value={f.id}>{f.name}</option>
                  ))}
                </Select>
              </label>
              <div className="flex flex-wrap items-center gap-1.5">
                {row.tags.map((t) => (
                  <Badge key={t} variant="secondary" className="gap-1">
                    {t}
                    <button type="button" aria-label={`Remove tag ${t}`} onClick={() => onUntag(t)}><X aria-hidden className="size-3" /></button>
                  </Badge>
                ))}
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (!tagDraft.trim()) return;
                    void onTag(tagDraft).then((ok) => ok && setTagDraft(""));
                  }}
                >
                  <input value={tagDraft} onChange={(e) => setTagDraft(e.target.value)} maxLength={40} aria-label="Add a tag" placeholder="Add tag" className="border-input bg-background h-7 w-24 rounded-md border px-2 text-xs" />
                </form>
              </div>
            </section>
            <PartyBlocks parties={data.review.parties} />
            <section>
              <h3 className="text-muted-foreground mb-1 text-xs">Excerpt</h3>
              {data.excerpt ? (
                <p className="text-foreground/90 line-clamp-[12] whitespace-pre-line">{data.excerpt}</p>
              ) : (
                <p className="text-muted-foreground">
                  {data.review.extraction?.error ? `Not read: ${data.review.extraction.error}` : "Nothing has been read from this document yet."}
                </p>
              )}
            </section>
            {data.review.obligations.length > 0 ? (
              <section>
                <h3 className="text-muted-foreground mb-1 text-xs">Obligations</h3>
                <ul className="flex flex-col gap-1.5">
                  {data.review.obligations.map((o) => (
                    <li key={o.id} className="flex items-baseline justify-between gap-2">
                      <span>{o.note ?? o.kind}</span>
                      <Badge variant="outline">{o.status}</Badge>
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}
          </>
        ) : tab === "evidence" ? (
          data.review.fieldProposals.length === 0 ? (
            <p className="text-muted-foreground">No fields have been proposed for this document.</p>
          ) : (
            <ul className="flex flex-col gap-3">
              {data.review.fieldProposals.map((p) => (
                <li key={p.id} className="flex flex-col gap-1">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="text-muted-foreground text-xs">{p.fieldName.replace(/_/g, " ")}</span>
                    <Badge variant={p.status === "proposed" ? "default" : "outline"}>{p.status}</Badge>
                  </div>
                  <Readout className="text-foreground">{p.rawValue ?? "-"}</Readout>
                  {p.evidenceQuote ? (
                    <blockquote className="border-border text-muted-foreground border-l-2 pl-2 text-xs">{p.evidenceQuote}</blockquote>
                  ) : null}
                </li>
              ))}
            </ul>
          )
        ) : data.activity.length === 0 ? (
          <p className="text-muted-foreground">No activity recorded yet.</p>
        ) : (
          <ol className="flex flex-col gap-2.5">
            {data.activity.map((a) => (
              <li key={`${a.kind}-${a.id}`} className="flex gap-3">
                <Readout className="text-muted-foreground w-28 shrink-0 text-xs">{stamp.format(new Date(a.at))}</Readout>
                <span>{a.summary}</span>
              </li>
            ))}
          </ol>
        )}
      </div>
    </aside>
  );
}
