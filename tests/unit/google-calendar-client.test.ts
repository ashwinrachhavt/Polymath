import { describe, expect, it, vi } from "vitest";
import { composioGoogleCalendarClient } from "@/integrations/google-calendar/client";

const window = { timeMin: "2026-10-01T00:00:00Z", timeMax: "2027-04-01T00:00:00Z" };

function fakeFetch(pages: unknown[]) {
  let i = 0;
  return vi.fn(async () => new Response(JSON.stringify(pages[i++]), { status: 200 }));
}

describe("composio google calendar client", () => {
  it("requires the API key", () => {
    expect(() => composioGoogleCalendarClient("ca_1", {} as NodeJS.ProcessEnv)).toThrow(/COMPOSIO_API_KEY/);
  });

  it("pages through results, unwraps data, and reports the newest updated stamp", async () => {
    const f = fakeFetch([
      { data: { items: [{ id: "a", updated: "2026-10-02T00:00:00Z" }], nextPageToken: "t2" } },
      { items: [{ id: "b", updated: "2026-10-05T00:00:00Z" }] },
    ]);
    const client = composioGoogleCalendarClient("ca_1", { COMPOSIO_API_KEY: "k" } as unknown as NodeJS.ProcessEnv, f as unknown as typeof fetch);
    const r = await client.listEventsUpdatedSince("2026-10-01T00:00:00Z", window);
    expect(r.events.map((e) => e.id)).toEqual(["a", "b"]);
    expect(r.newestUpdated).toBe("2026-10-05T00:00:00Z");
    expect(r.truncated).toBe(false);
    const first = JSON.parse((f.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(first.connected_account_id).toBe("ca_1");
    expect(first.method).toBe("GET");
    expect(first.parameters).toContainEqual({ name: "updatedMin", value: "2026-10-01T00:00:00Z", type: "query" });
    expect(first.parameters).toContainEqual({ name: "showDeleted", value: "true", type: "query" });
    const second = JSON.parse((f.mock.calls[1] as unknown as [string, RequestInit])[1].body as string);
    expect(second.parameters).toContainEqual({ name: "pageToken", value: "t2", type: "query" });
  });

  it("fails loudly when a 200 carries no event list, never a fake empty day", async () => {
    for (const body of [{ data: { error: { message: "backend errors" } } }, { data: {} }, "not an object"]) {
      const f = fakeFetch([body]);
      const client = composioGoogleCalendarClient("ca_1", { COMPOSIO_API_KEY: "k" } as unknown as NodeJS.ProcessEnv, f as unknown as typeof fetch);
      await expect(client.listEventsUpdatedSince(null, window)).rejects.toThrow(/unexpected response/);
    }
  });

  it("reports truncation when the page cap cuts the read short", async () => {
    const page = { items: [{ id: "a", updated: "2026-10-02T00:00:00Z" }], nextPageToken: "more" };
    const f = fakeFetch(Array.from({ length: 10 }, () => page));
    const client = composioGoogleCalendarClient("ca_1", { COMPOSIO_API_KEY: "k" } as unknown as NodeJS.ProcessEnv, f as unknown as typeof fetch);
    const r = await client.listEventsUpdatedSince(null, window);
    expect(r.truncated).toBe(true);
    expect(r.events).toHaveLength(10);
  });

  it("fails loudly on a non-200", async () => {
    const f = vi.fn(async () => new Response("no", { status: 401 }));
    const client = composioGoogleCalendarClient("ca_1", { COMPOSIO_API_KEY: "k" } as unknown as NodeJS.ProcessEnv, f as unknown as typeof fetch);
    await expect(client.listEventsUpdatedSince(null, window)).rejects.toThrow(/HTTP 401/);
  });
});
