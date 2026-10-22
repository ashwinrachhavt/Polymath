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
  | { ok: true; items: string[]; truncated: boolean }
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
  // Discord's channel list needs a guild id the tool does not take, so the
  // generic read lists the guilds (servers) the connection can see.
  discord_list_channels: {
    tool: "discord_list_channels",
    capability: "discord.guilds.read",
    endpoint: "https://discord.com/api/v10/users/@me/guilds",
    listPath: "",
    itemText: (item) => {
      const g = item as { name?: string; id?: string };
      return [g.name ?? "(unnamed server)", g.id].filter(Boolean).join(" — ");
    },
  },
  zoom_list_meetings: {
    tool: "zoom_list_meetings",
    capability: "zoom.meetings.read",
    endpoint: "https://api.zoom.us/v2/users/me/meetings",
    listPath: "meetings",
    itemText: (item) => {
      const m = item as { topic?: string; start_time?: string };
      return [m.topic ?? "(untitled meeting)", m.start_time ?? ""].filter(Boolean).join(" — ");
    },
  },
  calendly_list_events: {
    tool: "calendly_list_events",
    capability: "calendly.events.read",
    endpoint: "https://calendly.com/api/v1/users/me/scheduled_events",
    query: { count: "25" },
    listPath: "collection",
    itemText: (item) => {
      const e = item as { name?: string; start_time?: string };
      return [e.name ?? "(untitled event)", e.start_time ?? ""].filter(Boolean).join(" — ");
    },
  },
  asana_list_tasks: {
    tool: "asana_list_tasks",
    capability: "asana.tasks.read",
    endpoint: "https://app.asana.com/api/1.0/tasks",
    query: { assignee: "me", completed_since: "now", opt_fields: "name,due_on" },
    listPath: "data",
    itemText: (item) => {
      const t = item as { name?: string; due_on?: string | null };
      return [t.name ?? "(untitled task)", t.due_on ?? ""].filter(Boolean).join(" — ");
    },
  },
  trello_list_cards: {
    tool: "trello_list_cards",
    capability: "trello.cards.read",
    endpoint: "https://api.trello.com/1/members/me/cards",
    listPath: "",
    itemText: (item) => {
      const c = item as { name?: string; due?: string | null };
      return [c.name ?? "(untitled card)", c.due ?? ""].filter(Boolean).join(" — ");
    },
  },
  // Airtable records need a base and a table the tool does not take, so the
  // generic read lists the bases; the description says what it returns.
  airtable_list_records: {
    tool: "airtable_list_records",
    capability: "airtable.bases.read",
    endpoint: "https://api.airtable.com/v0/meta/bases",
    listPath: "bases",
    itemText: (item) => {
      const b = item as { name?: string; id?: string };
      return [b.name ?? "(unnamed base)", b.id].filter(Boolean).join(" — ");
    },
  },
  canva_list_designs: {
    tool: "canva_list_designs",
    capability: "canva.designs.read",
    endpoint: "https://www.canva.com/api/v1/designs",
    listPath: "items",
    itemText: (item) => {
      const d = item as { title?: string; design?: { id?: string } };
      return [d.title ?? "(untitled design)", d.design?.id].filter(Boolean).join(" — ");
    },
  },
  hubspot_list_contacts: {
    tool: "hubspot_list_contacts",
    capability: "hubspot.contacts.read",
    endpoint: "https://api.hubapi.com/crm/v3/objects/contacts",
    query: { limit: "25" },
    listPath: "results",
    itemText: (item) => {
      const c = item as { properties?: { email?: string; firstname?: string; lastname?: string } };
      const name = [c.properties?.firstname, c.properties?.lastname].filter(Boolean).join(" ");
      return [name || c.properties?.email || "(unnamed contact)", c.properties?.email]
        .filter(Boolean)
        .join(" — ");
    },
  },
  stripe_list_payments: {
    tool: "stripe_list_payments",
    capability: "stripe.payments.read",
    endpoint: "https://api.stripe.com/v1/charges",
    query: { limit: "25" },
    listPath: "data",
    itemText: (item) => {
      const p = item as { description?: string; amount?: number; currency?: string; created?: number };
      const when = p.created ? new Date(p.created * 1000).toISOString().slice(0, 10) : "";
      const amount = p.amount !== undefined ? `${(p.amount / 100).toFixed(2)} ${p.currency ?? ""}` : "";
      return [p.description ?? "(no description)", amount, when].filter(Boolean).join(" — ");
    },
  },
};

function resolveQuery(spec: GenericReadSpec, query: string | undefined): Record<string, string> | undefined {
  if (!spec.query) return undefined;
  const resolved: Record<string, string> = {};
  for (const [key, template] of Object.entries(spec.query)) {
    if (template === "{query}") {
      // No search text, no search param: sending an empty filter would be a
      // provider error or, worse, a silently different query.
      if (!query?.trim()) continue;
      // Escape the provider query language's quote (Drive's q): the value is
      // data, never a filter edit.
      resolved[key] = query.trim().replaceAll("'", "\\'");
      continue;
    }
    resolved[key] = template;
  }
  return Object.keys(resolved).length ? resolved : undefined;
}

function pickListPath(data: unknown, listPath: string): { ok: true; items: unknown[] } | { ok: false; message: string } {
  // An empty listPath means the response body itself is the array.
  if (listPath === "") {
    return Array.isArray(data) ? { ok: true, items: data } : { ok: false, message: "The provider response was not a list." };
  }
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
  let truncated = false;
  for (const item of picked.items.slice(0, limit)) {
    const text = spec.itemText(item);
    // The joined block is what the model sees, so the bound applies to it, not
    // to the raw response: a wide item truncates the list, not the budget.
    if (total + text.length + 1 > LIMITS.maxResponseBytes) {
      truncated = true;
      break;
    }
    items.push(text);
    total += text.length + 1;
  }
  // Fewer items than the provider offered is also a cut, not an empty provider.
  if (picked.items.length > limit) truncated = true;
  return { ok: true, items, truncated };
}
