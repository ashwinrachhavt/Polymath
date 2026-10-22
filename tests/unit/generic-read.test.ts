import { describe, expect, it } from "vitest";
import { genericList, type GenericReadSpec } from "@/domains/integrations/reads/generic";
import type { Transport, TransportRequest, TransportResult } from "@/domains/integrations/transport";
import { LIMITS } from "@/domains/integrations/capabilities";
import { GENERIC_READS } from "@/domains/integrations/reads/generic";

/*
 * The generic read pathway: one list-endpoint reader every registry entry
 * shares, so a provider slice is a spec (endpoint, list path, item text) and
 * not another bespoke read function. Truncation and failure shape are the
 * transport's contract, proved once here.
 */

function fakeTransport(response: TransportResult, seen?: { request?: TransportRequest }): Transport {
  return {
    async read(request: TransportRequest) {
      if (seen) seen.request = request;
      return response;
    },
  };
}

const spec: GenericReadSpec = {
  tool: "hubspot_search_contacts",
  capability: "gmail.read", // placeholder; the registry (Tasks 8-11) maps real capabilities
  endpoint: "https://api.example.test/crm/v3/objects/contacts/search",
  query: { q: "{query}" },
  listPath: "results",
  itemText: (item) => {
    const r = item as { properties?: { email?: string } };
    return r.properties?.email ?? "?";
  },
};

describe("genericList", () => {
  it("maps listPath to item texts and truncates at LIMITS.maxResponseBytes", async () => {
    const items = Array.from({ length: 200 }, (_, i) => ({ properties: { email: `person-${i}@example.test` } }));
    const seen: { request?: TransportRequest } = {};
    const transport = fakeTransport({ ok: true, status: 200, data: { results: items } }, seen);

    const result = await genericList(transport, spec, { connectedAccountId: "ca_1", limit: 50 });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.items).toHaveLength(50);
    expect(result.items[0]).toBe("person-0@example.test");
    expect(result.items.join("\n").length).toBeLessThanOrEqual(LIMITS.maxResponseBytes);
    expect(seen.request?.endpoint).toBe(spec.endpoint);
    expect(seen.request?.method).toBe("GET");
  });

  it("sends the query through the spec's template", async () => {
    const seen: { request?: TransportRequest } = {};
    const transport = fakeTransport({ ok: true, status: 200, data: { results: [] } }, seen);

    await genericList(transport, spec, { connectedAccountId: "ca_1", query: "ashwin" });

    expect(seen.request?.query).toMatchObject({ q: "ashwin" });
  });

  it("a non-2xx becomes a provider_error with the status", async () => {
    const transport = fakeTransport({ ok: false, code: "provider_error", status: 403, message: "forbidden" });

    const result = await genericList(transport, spec, { connectedAccountId: "ca_1" });

    expect(result).toMatchObject({ ok: false, code: "provider_error", message: "forbidden" });
  });

  it("a missing listPath is a read failure, not a crash", async () => {
    const transport = fakeTransport({ ok: true, status: 200, data: {} });

    const result = await genericList(transport, spec, { connectedAccountId: "ca_1" });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain("results");
  });

  it("a non-array listPath is a read failure too", async () => {
    const transport = fakeTransport({ ok: true, status: 200, data: { results: "not-an-array" } });

    const result = await genericList(transport, spec, { connectedAccountId: "ca_1" });

    expect(result.ok).toBe(false);
  });
});

describe("GENERIC_READS google cluster", () => {
  const entries = Object.entries(GENERIC_READS).filter(([tool]) => tool.startsWith("google"));
  it("registers one spec per google provider read tool with the real endpoint and listPath", () => {
    const expected: Array<[string, string, string]> = [
      ["googlecalendar_list_events", "https://calendar.googleapis.com/calendar/v3/calendars/primary/events", "items"],
      ["googledrive_search_files", "https://www.googleapis.com/drive/v3/files", "files"],
      ["googledocs_list_documents", "https://docs.googleapis.com/v1/documents", "documents"],
      ["googlesheets_list_sheets", "https://sheets.googleapis.com/v4/spreadsheets", "sheets"],
    ];
    for (const [tool, endpoint, listPath] of expected) {
      const spec = GENERIC_READS[tool];
      expect(spec, tool).toBeTruthy();
      expect(spec!.endpoint, tool).toBe(endpoint);
      expect(spec!.listPath, tool).toBe(listPath);
    }
    expect(entries.length).toBeGreaterThanOrEqual(4);
  });

  it("maps a calendar fixture response to one line per event", async () => {
    const spec = GENERIC_READS.googlecalendar_list_events;
    const transport = fakeTransport({
      ok: true,
      status: 200,
      data: {
        items: [
          { summary: "Standup", start: { dateTime: "2026-10-22T09:00:00Z" } },
          { summary: "Review", start: { dateTime: "2026-10-22T14:00:00Z" } },
        ],
      },
    });
    const result = await genericList(transport, spec!, { connectedAccountId: "ca_1" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.items[0]).toContain("Standup");
      expect(result.items[0]).toContain("2026-10-22");
    }
  });

  it("maps a drive fixture response to one line per file", async () => {
    const spec = GENERIC_READS.googledrive_search_files;
    const transport = fakeTransport({
      ok: true,
      status: 200,
      data: { files: [{ name: "Q3 plan", id: "f1", mimeType: "application/pdf" }] },
    });
    const result = await genericList(transport, spec!, { connectedAccountId: "ca_1" });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.items[0]).toContain("Q3 plan");
  });
});
