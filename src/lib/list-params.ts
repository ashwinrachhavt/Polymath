/*
 * One contract for every list surface: search, filters, page and page size
 * live in the URL, so a filtered view is a link you can share, reload, or
 * come back to with the browser's back button. Parsing is strict - an unknown
 * filter value or a nonsense page falls back to the default instead of
 * throwing, because a hand-edited URL should never crash a page.
 */

export type RawSearchParams = Record<string, string | string[] | undefined>;

export const PAGE_SIZES = [10, 25, 50, 100] as const;
export const DEFAULT_PAGE_SIZE = 25;
const MAX_QUERY_LENGTH = 120;

export type ListState<F extends string = string> = {
  q: string;
  page: number;
  pageSize: number;
  filters: Partial<Record<F, string>>;
};

export type ListSpec<F extends string = string> = {
  /** Allowed values per filter key. A value outside the list is ignored. */
  filters?: Record<F, readonly string[]>;
  defaultPageSize?: number;
  /** Query key holding the search text. Default "q"; a screen with a second search box picks another. */
  qKey?: string;
};

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export function positiveInt(value: string | undefined): number | undefined {
  if (!value || !/^\d{1,6}$/.test(value)) return undefined;
  const n = Number(value);
  return n >= 1 ? n : undefined;
}

export function parseListParams<F extends string>(raw: RawSearchParams, spec: ListSpec<F> = {}): ListState<F> {
  const defaultPageSize = spec.defaultPageSize ?? DEFAULT_PAGE_SIZE;
  const q = (first(raw[spec.qKey ?? "q"]) ?? "").trim().slice(0, MAX_QUERY_LENGTH);
  const requestedSize = positiveInt(first(raw.size));
  const pageSize =
    requestedSize && (PAGE_SIZES as readonly number[]).includes(requestedSize) ? requestedSize : defaultPageSize;
  const filters: Partial<Record<F, string>> = {};
  for (const key of Object.keys(spec.filters ?? {}) as F[]) {
    const value = first(raw[key]);
    if (value && spec.filters![key].includes(value)) filters[key] = value;
  }
  return { q, page: positiveInt(first(raw.page)) ?? 1, pageSize, filters };
}

/** Page number from a raw query value (any pager key): 1 when absent or invalid. */
export function parsePageNumber(value: string | string[] | undefined): number {
  return positiveInt(first(value)) ?? 1;
}

export function pageCount(total: number, pageSize: number): number {
  return Math.max(1, Math.ceil(total / pageSize));
}

/** A page past the end (a filter shrank the result) lands on the last page. */
export function clampPage(page: number, total: number, pageSize: number): number {
  return Math.min(Math.max(1, page), pageCount(total, pageSize));
}

export function offsetFor(page: number, pageSize: number): number {
  return (Math.max(1, page) - 1) * pageSize;
}

export function rangeLabel(page: number, pageSize: number, total: number): string {
  if (total === 0) return "0 results";
  const start = offsetFor(page, pageSize) + 1;
  const end = Math.min(total, start + pageSize - 1);
  return `${start}\u2013${end} of ${total}`;
}

/** Page numbers to render: always first and last, a window around the current page, gaps as null. */
export function pageWindow(page: number, pages: number, radius = 1): Array<number | null> {
  const wanted = new Set<number>([1, pages]);
  for (let p = page - radius; p <= page + radius; p++) if (p >= 1 && p <= pages) wanted.add(p);
  const sorted = [...wanted].sort((a, b) => a - b);
  const out: Array<number | null> = [];
  sorted.forEach((p, i) => {
    if (i > 0 && p - sorted[i - 1]! > 1) out.push(null);
    out.push(p);
  });
  return out;
}

/** Same page, with some params replaced. Empty values and the defaults drop out of the URL. */
export function listHref(
  basePath: string,
  raw: RawSearchParams,
  patch: Record<string, string | number | undefined>,
): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(raw)) {
    const v = first(value);
    if (v !== undefined && v !== "") params.set(key, v);
  }
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined || value === "" || (key === "page" && Number(value) === 1)) params.delete(key);
    else params.set(key, String(value));
  }
  const qs = params.toString();
  return qs ? `${basePath}?${qs}` : basePath;
}

/** Case-insensitive substring match across fields, for lists already in memory. */
export function matchesQuery(q: string, ...fields: Array<string | null | undefined>): boolean {
  const needle = q.trim().toLowerCase();
  if (!needle) return true;
  return fields.some((f) => f?.toLowerCase().includes(needle));
}

export function paginate<T>(items: readonly T[], page: number, pageSize: number): { items: T[]; page: number; total: number } {
  const total = items.length;
  const safe = clampPage(page, total, pageSize);
  const start = offsetFor(safe, pageSize);
  return { items: items.slice(start, start + pageSize), page: safe, total };
}

/** LIKE metacharacters typed into a search box are literal text, not patterns. */
export function escapeLike(value: string): string {
  return value.replace(/[%_\\]/g, (match) => `\\${match}`);
}
