import { ChevronLeft, ChevronRight } from "lucide-react";
import Link from "next/link";
import { PageSizeSelect } from "@/components/list/page-size-select";
import { listHref, pageCount, pageWindow, rangeLabel, type RawSearchParams } from "@/lib/list-params";

/*
 * Server-rendered pager: every control is a real link, so it works without
 * client JS, keeps the filters in the URL, and is reachable by keyboard and
 * screen reader. Renders nothing when there is only one page and the list is
 * short enough that a page size picker would be noise.
 */

const linkBase =
  "inline-flex h-8 min-w-8 items-center justify-center rounded-md border px-2 text-[13px] outline-none focus-visible:ring-2 focus-visible:ring-ring";

export function Pagination({
  basePath,
  raw,
  page,
  pageSize,
  total,
  pageParam = "page",
  compact = false,
}: {
  basePath: string;
  raw: RawSearchParams;
  page: number;
  pageSize: number;
  total: number;
  /** Query key for the page number; a second list on one screen uses its own. */
  pageParam?: string;
  /** Narrow columns: prev/next and "n / m" only, no number strip or page size. */
  compact?: boolean;
}) {
  const pages = pageCount(total, pageSize);
  if (pages === 1 && (compact || total <= 10)) return null;
  const href = (p: number) => listHref(basePath, raw, { [pageParam]: p === 1 ? undefined : p });
  return (
    <nav aria-label="Pagination" className="flex flex-wrap items-center justify-between gap-3 pt-3">
      <p className="text-muted-foreground readout text-xs" aria-live="polite">
        {rangeLabel(page, pageSize, total)}
      </p>
      <div className="flex flex-wrap items-center gap-3">
        {compact ? null : <PageSizeSelect value={pageSize} pageParam={pageParam} />}
        {pages > 1 ? (
          <ul className="flex items-center gap-1">
            <li>
              {page > 1 ? (
                <Link href={href(page - 1)} rel="prev" aria-label="Previous page" scroll={false} className={`${linkBase} border-border hover:bg-muted`}>
                  <ChevronLeft aria-hidden className="size-4" />
                </Link>
              ) : (
                <span aria-hidden className={`${linkBase} border-transparent opacity-40`}>
                  <ChevronLeft className="size-4" />
                </span>
              )}
            </li>
            {pageWindow(page, pages).map((p, i) => (
              <li key={p ?? `gap-${i}`} className={compact ? "hidden" : "hidden sm:block"}>
                {p === null ? (
                  <span aria-hidden className="text-muted-foreground px-1 text-xs">…</span>
                ) : (
                  <Link
                    href={href(p)}
                    scroll={false}
                    aria-label={`Page ${p}`}
                    aria-current={p === page ? "page" : undefined}
                    className={`${linkBase} ${p === page ? "border-foreground bg-foreground text-background" : "border-border hover:bg-muted"}`}
                  >
                    {p}
                  </Link>
                )}
              </li>
            ))}
            <li className={`text-muted-foreground px-1 text-xs ${compact ? "" : "sm:hidden"}`}>
              {page} / {pages}
            </li>
            <li>
              {page < pages ? (
                <Link href={href(page + 1)} rel="next" aria-label="Next page" scroll={false} className={`${linkBase} border-border hover:bg-muted`}>
                  <ChevronRight aria-hidden className="size-4" />
                </Link>
              ) : (
                <span aria-hidden className={`${linkBase} border-transparent opacity-40`}>
                  <ChevronRight className="size-4" />
                </span>
              )}
            </li>
          </ul>
        ) : null}
      </div>
    </nav>
  );
}
