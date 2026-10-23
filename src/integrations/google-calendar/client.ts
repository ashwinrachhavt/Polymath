import type { GoogleEvent } from "@/domains/calendar/google-mapper";

/*
 * The Google Calendar read surface the sync needs, behind one interface. The
 * real adapter reaches Google through Composio's proxy endpoint, like the
 * Notion adapter: Polymath stores the Composio connected-account id, never a
 * token. Read-only. Tests plug in a fake.
 */

export interface GoogleCalendarClient {
  /** Events changed after `updatedMin` (ISO), cancelled ones included, recurring events expanded. */
  listEventsUpdatedSince(updatedMin: string | null, window: { timeMin: string; timeMax: string }): Promise<{
    events: GoogleEvent[];
    /** Newest `updated` stamp seen, the next watermark. */
    newestUpdated: string | null;
    /**
     * True when the page cap cut the read short with more pages pending.
     * Callers with a watermark (sync) make progress on the next run; callers
     * without one (the briefing agenda) must not present the partial list as
     * complete.
     */
    truncated: boolean;
  }>;
}

const PROXY_URL = "https://backend.composio.dev/api/v3/tools/execute/proxy";
const EVENTS_URL = "https://www.googleapis.com/calendar/v3/calendars/primary/events";
const MAX_PAGES = 10;

type ProxyFetch = typeof fetch;
type RawEvent = GoogleEvent & { updated?: string };

export function composioGoogleCalendarClient(
  connectedAccountId: string,
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: ProxyFetch = fetch,
): GoogleCalendarClient {
  const apiKey = env.COMPOSIO_API_KEY;
  if (!apiKey) throw new Error("COMPOSIO_API_KEY is not set.");
  return {
    async listEventsUpdatedSince(updatedMin, window) {
      const events: GoogleEvent[] = [];
      let newest: string | null = null;
      let pageToken: string | undefined;
      let page = 0;
      for (; page < MAX_PAGES; page += 1) {
        const query: Record<string, string> = {
          singleEvents: "true",
          showDeleted: "true",
          maxResults: "250",
          orderBy: "updated",
          timeMin: window.timeMin,
          timeMax: window.timeMax,
        };
        if (updatedMin) query.updatedMin = updatedMin;
        if (pageToken) query.pageToken = pageToken;
        const res = await fetchImpl(PROXY_URL, {
          method: "POST",
          headers: { "x-api-key": apiKey, "Content-Type": "application/json" },
          body: JSON.stringify({
            connected_account_id: connectedAccountId,
            endpoint: EVENTS_URL,
            method: "GET",
            parameters: Object.entries(query).map(([name, value]) => ({ name, value, type: "query" })),
          }),
        });
        if (!res.ok) throw new Error(`Google Calendar read failed (HTTP ${res.status}).`);
        const body = (await res.json()) as { data?: { items?: RawEvent[]; nextPageToken?: string }; items?: RawEvent[]; nextPageToken?: string };
        // The proxy wraps the provider body under `data`; accept either shape.
        const payload = body.data ?? body;
        // A 200 whose body is not an event list (provider error page, proxy
        // envelope, HTML) must fail loudly: treating a missing `items` as an
        // empty list would read a broken calendar as a free day.
        if (!payload || typeof payload !== "object" || !Array.isArray(payload.items)) {
          throw new Error("Google Calendar returned an unexpected response.");
        }
        for (const item of payload.items) {
          events.push(item);
          if (item.updated && (!newest || item.updated > newest)) newest = item.updated;
        }
        pageToken = payload.nextPageToken;
        if (!pageToken) break;
      }
      return { events, newestUpdated: newest, truncated: Boolean(pageToken) };
    },
  };
}
