import { LIMITS, type Capability } from "@/domains/integrations/capabilities";
import type { Transport } from "@/domains/integrations/transport";

/*
 * The generic read: one list-endpoint reader shared by every registry entry.
 * A provider slice declares where to GET, where the array sits in the response,
 * and how one item becomes a text line — the transport, truncation bound, and
 * failure shape stay the transport seam's contract, proved once in
 * tests/unit/generic-read.test.ts.
 *
 * `query` values are templates: a value of "{query}" receives the caller's
 * search text. Absent template values are dropped, so a spec can carry
 * constant params and the optional search param in one map.
 */

export type GenericReadSpec = {
  tool: string;
  capability: Capability;
  endpoint: string;
  query?: Record<string, string>;
  /** Dotted path into the response JSON carrying the array, e.g. "results" or "data.items". */
  listPath: string;
  itemText: (item: unknown) => string;
};

export type GenericListResult =
  | { ok: true; items: string[] }
  | { ok: false; code: string; message: string };

export const GENERIC_READS: Record<string, GenericReadSpec> = {
  googlecalendar_list_events: {
    tool: "googlecalendar_list_events",
    capability: "googlecalendar.events.read",
    endpoint: "https://calendar.googleapis.com/calendar/v3/calendars/primary/events",
    query: { timeMin: "{query}", singleEvents: "true", orderBy: "startTime" },
    listPath: "items",
    itemText: (item) => {
      const e = item as { summary?: string; start?: { dateTime?: string; date?: string } };
      const when = e.start?.dateTime ?? e.start?.date ?? "";
      return [e.summary ?? "(untitled event)", when].filter(Boolean).join(" — ");
    },
  },
  googledrive_search_files: {
    tool: "googledrive_search_files",
    capability: "googledrive.files.read",
    endpoint: "https://www.googleapis.com/drive/v3/files",
    query: { q: "name contains '{query}'", fields: "files(id,name,mimeType)" },
    listPath: "files",
    itemText: (item) => {
      const f = item as { name?: string; mimeType?: string };
      return [f.name ?? "(untitled file)", f.mimeType].filter(Boolean).join(" — ");
    },
  },
  googledocs_list_documents: {
    tool: "googledocs_list_documents",
    capability: "googledocs.documents.read",
    endpoint: "https://docs.googleapis.com/v1/documents",
    listPath: "documents",
    itemText: (item) => {
      const d = item as { title?: string; documentId?: string };
      return [d.title ?? "(untitled document)", d.documentId].filter(Boolean).join(" — ");
    },
  },
  googlesheets_list_sheets: {
    tool: "googlesheets_list_sheets",
    capability: "googlesheets.sheets.read",
    endpoint: "https://sheets.googleapis.com/v4/spreadsheets",
    listPath: "sheets",
    itemText: (item) => {
      const s = item as { properties?: { title?: string; spreadsheetId?: string } };
      return [s.properties?.title ?? "(untitled spreadsheet)", s.properties?.spreadsheetId]
        .filter(Boolean)
        .join(" — ");
    },
  },
};

function resolveQuery(spec: GenericReadSpec, query: string | undefined): Record<string, string> | undefined {
  if (!spec.query) return undefined;
  const resolved: Record<string, string> = {};
  for (const [key, template] of Object.entries(spec.query)) {
    resolved[key] = template === "{query}" ? (query ?? "") : template;
  }
  return resolved;
}

function pickListPath(data: unknown, listPath: string): { ok: true; items: unknown[] } | { ok: false; message: string } {
  let current: unknown = data;
  for (const segment of listPath.split(".")) {
    if (current === null || typeof current !== "object" || !(segment in (current as Record<string, unknown>))) {
      return { ok: false, message: `The provider response had no "${listPath}" list to read.` };
    }
    current = (current as Record<string, unknown>)[segment];
  }
  if (!Array.isArray(current)) {
    return { ok: false, message: `The provider response's "${listPath}" was not a list.` };
  }
  return { ok: true, items: current };
}

export async function genericList(
  transport: Transport,
  spec: GenericReadSpec,
  input: { connectedAccountId: string; query?: string; limit?: number },
): Promise<GenericListResult> {
  const result = await transport.read({
    connectedAccountId: input.connectedAccountId,
    endpoint: spec.endpoint,
    method: "GET",
    query: resolveQuery(spec, input.query),
  });
  if (!result.ok) return result;

  const picked = pickListPath(result.data, spec.listPath);
  if (!picked.ok) return { ok: false, code: "provider_error", message: picked.message };

  const limit = Math.min(Math.max(input.limit ?? LIMITS.defaultResults, 1), LIMITS.maxResults);
  let total = 0;
  const items: string[] = [];
  for (const item of picked.items.slice(0, limit)) {
    const text = spec.itemText(item);
    // The joined block is what the model sees, so the bound applies to it, not
    // to the raw response: a wide item truncates the list, not the budget.
    if (total + text.length + 1 > LIMITS.maxResponseBytes) break;
    items.push(text);
    total += text.length + 1;
  }
  return { ok: true, items };
}
