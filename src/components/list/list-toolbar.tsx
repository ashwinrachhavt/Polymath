"use client";

import { Search, X } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import { Select } from "@/components/ui/select";

/*
 * The one filter bar. It owns no data: every control writes to the URL and
 * the server page re-renders from it, so a filtered view is a link and the
 * back button undoes a filter. Changing anything resets to page 1; unrelated
 * params (a selected row, say) are left alone. Search applies after a short
 * pause rather than on every keystroke; "/" focuses it from anywhere on the
 * page that is not a text field.
 */

export type ToolbarFilter = {
  key: string;
  label: string;
  /** Label for the unfiltered choice, e.g. "All statuses". */
  allLabel: string;
  options: Array<{ value: string; label: string }>;
};

const SEARCH_DELAY_MS = 300;

export function ListToolbar({
  searchPlaceholder = "Search",
  filters = [],
  total,
  noun,
  qKey = "q",
}: {
  searchPlaceholder?: string;
  filters?: ToolbarFilter[];
  /** When given, a live "N noun" count sits at the end of the bar. */
  total?: number;
  noun?: string;
  /** Query key for the search text; must match the page's parseListParams qKey. */
  qKey?: string;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [pending, startTransition] = useTransition();
  const urlQuery = params.get(qKey) ?? "";
  const [draft, setDraft] = useState(urlQuery);
  const inputRef = useRef<HTMLInputElement>(null);
  const lastPushed = useRef(urlQuery);

  function push(patch: Record<string, string | undefined>) {
    const next = new URLSearchParams(params.toString());
    for (const [key, value] of Object.entries(patch)) {
      if (value) next.set(key, value);
      else next.delete(key);
    }
    // Any pager on the screen (page, cpage, ...) restarts at its first page.
    for (const key of [...next.keys()]) if (/^[a-z]*page$/.test(key)) next.delete(key);
    const qs = next.toString();
    startTransition(() => router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false }));
  }

  // Back/forward or "clear all" changed the URL under us: follow it.
  useEffect(() => {
    if (urlQuery !== lastPushed.current) {
      lastPushed.current = urlQuery;
      setDraft(urlQuery);
    }
  }, [urlQuery]);

  useEffect(() => {
    if (draft.trim() === urlQuery) return;
    const id = setTimeout(() => {
      lastPushed.current = draft.trim();
      push({ [qKey]: draft.trim() || undefined });
    }, SEARCH_DELAY_MS);
    return () => clearTimeout(id);
    // push closes over params; the debounce only needs to restart on typing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft]);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey) return;
      const el = document.activeElement;
      if (el instanceof HTMLElement && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))) return;
      event.preventDefault();
      inputRef.current?.focus();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const active = filters
    .map((f) => ({ f, value: params.get(f.key) ?? "" }))
    .filter(({ f, value }) => value && f.options.some((o) => o.value === value));
  const anyActive = active.length > 0 || urlQuery !== "";

  return (
    <div role="search" className="flex flex-col gap-2" aria-busy={pending}>
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative w-full max-w-sm min-w-48 flex-1">
          <Search aria-hidden className="text-muted-foreground pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2" />
          <input
            ref={inputRef}
            type="search"
            aria-label={searchPlaceholder}
            placeholder={searchPlaceholder}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                setDraft("");
                e.currentTarget.blur();
              }
            }}
            className="border-input bg-background focus-visible:ring-ring h-9 w-full rounded-md border pr-3 pl-9 text-[13px] outline-none focus-visible:ring-2"
          />
        </div>
        {filters.map((f) => (
          <Select
            key={f.key}
            aria-label={f.label}
            className="w-40"
            value={params.get(f.key) ?? ""}
            onChange={(e) => push({ [f.key]: e.target.value || undefined })}
          >
            <option value="">{f.allLabel}</option>
            {f.options.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </Select>
        ))}
        {total !== undefined ? (
          <span className="text-muted-foreground readout ml-auto text-xs" aria-live="polite">
            {total} {noun ?? "results"}
          </span>
        ) : null}
      </div>
      {anyActive ? (
        <div className="flex flex-wrap items-center gap-1.5" aria-label="Active filters">
          {urlQuery ? <Chip label={`Search: ${urlQuery}`} onRemove={() => push({ [qKey]: undefined })} /> : null}
          {active.map(({ f, value }) => (
            <Chip
              key={f.key}
              label={`${f.label}: ${f.options.find((o) => o.value === value)!.label}`}
              onRemove={() => push({ [f.key]: undefined })}
            />
          ))}
          <button
            type="button"
            onClick={() => push({ [qKey]: undefined, ...Object.fromEntries(filters.map((f) => [f.key, undefined])) })}
            className="text-muted-foreground hover:text-foreground focus-visible:ring-ring rounded px-1 text-xs underline-offset-4 outline-none hover:underline focus-visible:ring-2"
          >
            Clear all
          </button>
        </div>
      ) : null}
    </div>
  );
}

function Chip({ label, onRemove }: { label: string; onRemove: () => void }) {
  return (
    <span className="border-border bg-muted/60 inline-flex h-6 items-center gap-1 rounded-full border pr-1 pl-2.5 text-xs">
      <span className="max-w-48 truncate">{label}</span>
      <button
        type="button"
        aria-label={`Remove filter ${label}`}
        onClick={onRemove}
        className="text-muted-foreground hover:text-foreground focus-visible:ring-ring inline-flex size-4 items-center justify-center rounded-full outline-none focus-visible:ring-2"
      >
        <X aria-hidden className="size-3" />
      </button>
    </span>
  );
}
