import { describe, expect, it } from "vitest";
import { genericList, type GenericReadSpec } from "@/domains/integrations/reads/generic";
import type { Transport, TransportRequest, TransportResult } from "@/domains/integrations/transport";
import { LIMITS } from "@/domains/integrations/capabilities";
import { CAPABILITIES, PROVIDER_TOOLS } from "@/domains/integrations/capabilities";
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
      ["googledocs_search_files", "https://www.googleapis.com/drive/v3/files", "files"],
      ["googlesheets_list_spreadsheets", "https://www.googleapis.com/drive/v3/files", "files"],
    ];
    for (const [tool, endpoint, listPath] of expected) {
      const spec = GENERIC_READS[tool];
      expect(spec, tool).toBeTruthy();
      expect(spec!.endpoint, tool).toBe(endpoint);
      expect(spec!.listPath, tool).toBe(listPath);
    }
    expect(entries.length).toBe(4);
  });

  it("docs and sheets filter Drive's files list by mimeType", () => {
    expect(GENERIC_READS.googledocs_search_files!.query?.q).toContain("application/vnd.google-apps.document");
    expect(GENERIC_READS.googlesheets_list_spreadsheets!.query?.q).toContain("application/vnd.google-apps.spreadsheet");
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

describe("GENERIC_READS comms cluster", () => {
  it("registers discord, zoom and calendly specs with their real endpoints and listPaths", () => {
    const expected: Array<[string, string, string]> = [
      ["discord_list_channels", "https://discord.com/api/v10/users/@me/guilds", ""],
      ["zoom_list_meetings", "https://api.zoom.us/v2/users/me/meetings", "meetings"],
      ["calendly_list_events", "https://api.calendly.com/scheduled_events", "collection"],
    ];
    for (const [tool, endpoint, listPath] of expected) {
      const spec = GENERIC_READS[tool];
      expect(spec, tool).toBeTruthy();
      expect(spec!.endpoint, tool).toBe(endpoint);
      if (listPath) expect(spec!.listPath, tool).toBe(listPath);
    }
  });

  it("maps a zoom fixture to one line per meeting", async () => {
    const transport = fakeTransport({
      ok: true,
      status: 200,
      data: { meetings: [{ topic: "Weekly sync", start_time: "2026-10-23T15:00:00Z" }] },
    });
    const result = await genericList(transport, GENERIC_READS.zoom_list_meetings!, { connectedAccountId: "ca_1" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.items[0]).toContain("Weekly sync");
      expect(result.items[0]).toContain("2026-10-23");
    }
  });
});

describe("GENERIC_READS work-management cluster", () => {
  it("registers asana, trello and airtable specs with their real endpoints and listPaths", () => {
    const expected: Array<[string, string, string]> = [
      ["asana_list_tasks", "https://app.asana.com/api/1.0/tasks", "data"],
      ["trello_list_cards", "https://api.trello.com/1/members/me/cards", ""],
      ["airtable_list_records", "https://api.airtable.com/v0/meta/bases", "bases"],
    ];
    for (const [tool, endpoint, listPath] of expected) {
      const spec = GENERIC_READS[tool];
      expect(spec, tool).toBeTruthy();
      expect(spec!.endpoint, tool).toBe(endpoint);
      expect(spec!.listPath, tool).toBe(listPath);
    }
  });

  it("jira is absent — its host is per-site and nothing resolves it statically", () => {
    expect(GENERIC_READS.jira_search_issues).toBeUndefined();
  });
});

describe("GENERIC_READS crm/finance cluster", () => {
  it("registers canva, hubspot and stripe specs with their real endpoints and listPaths", () => {
    const expected: Array<[string, string, string]> = [
      ["canva_list_designs", "https://api.canva.com/rest/v1/designs", "items"],
      ["hubspot_list_contacts", "https://api.hubapi.com/crm/v3/objects/contacts", "results"],
      ["stripe_list_payments", "https://api.stripe.com/v1/charges", "data"],
    ];
    for (const [tool, endpoint, listPath] of expected) {
      const spec = GENERIC_READS[tool];
      expect(spec, tool).toBeTruthy();
      expect(spec!.endpoint, tool).toBe(endpoint);
      expect(spec!.listPath, tool).toBe(listPath);
    }
  });

  it("maps a hubspot fixture to one line per contact", async () => {
    const transport = fakeTransport({
      ok: true,
      status: 200,
      data: { results: [{ properties: { email: "a@example.test" } }] },
    });
    const result = await genericList(transport, GENERIC_READS.hubspot_list_contacts!, { connectedAccountId: "ca_1" });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.items[0]).toContain("a@example.test");
  });

  it("figma, dropbox and salesforce are absent — their list reads are not GET-expressible", () => {
    expect(GENERIC_READS.figma_list_files).toBeUndefined();
    expect(GENERIC_READS.dropbox_list_files).toBeUndefined();
    expect(GENERIC_READS.salesforce_search_records).toBeUndefined();
  });
});

describe("GENERIC_READS preflight specs", () => {
  /** Answers by endpoint, recording the request sequence. */
  function sequencedTransport(routes: Record<string, TransportResult>, seen: TransportRequest[]): Transport {
    return {
      async read(request: TransportRequest) {
        seen.push(request);
        const response = routes[request.endpoint];
        if (!response) throw new Error(`no route for ${request.endpoint}`);
        return response;
      },
    };
  }

  it("calendly resolves the user and organization URIs before listing events", async () => {
    const seen: TransportRequest[] = [];
    const transport = sequencedTransport(
      {
        "https://api.calendly.com/users/me": {
          ok: true,
          status: 200,
          data: {
            resource: {
              uri: "https://api.calendly.com/users/USERID",
              current_organization: "https://api.calendly.com/organizations/ORGID",
            },
          },
        },
        "https://api.calendly.com/scheduled_events": {
          ok: true,
          status: 200,
          data: { collection: [{ name: "Intro call", start_time: "2026-10-24T17:00:00Z" }] },
        },
      },
      seen,
    );

    const result = await genericList(transport, GENERIC_READS.calendly_list_events!, { connectedAccountId: "ca_1" });

    expect(seen.map((request) => request.endpoint)).toEqual([
      "https://api.calendly.com/users/me",
      "https://api.calendly.com/scheduled_events",
    ]);
    expect(seen[1]!.query).toMatchObject({
      user: "https://api.calendly.com/users/USERID",
      organization: "https://api.calendly.com/organizations/ORGID",
      count: "25",
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.items[0]).toContain("Intro call");
  });

  it("calendly fails honestly when the profile lacks the URIs, and never lists", async () => {
    const seen: TransportRequest[] = [];
    const transport = sequencedTransport(
      { "https://api.calendly.com/users/me": { ok: true, status: 200, data: { resource: {} } } },
      seen,
    );

    const result = await genericList(transport, GENERIC_READS.calendly_list_events!, { connectedAccountId: "ca_1" });

    expect(result).toEqual({
      ok: false,
      code: "provider_error",
      message: "Calendly did not return the account profile the event list needs.",
    });
    expect(seen).toHaveLength(1);
  });

  it("asana sends the workspace gid its assignee filter requires", async () => {
    const seen: TransportRequest[] = [];
    const transport = sequencedTransport(
      {
        "https://app.asana.com/api/1.0/users/me": {
          ok: true,
          status: 200,
          data: { data: { gid: "me-gid", workspaces: [{ gid: "ws-1", name: "My Workspace" }] } },
        },
        "https://app.asana.com/api/1.0/tasks": {
          ok: true,
          status: 200,
          data: { data: [{ gid: "t1", name: "Ship it", due_on: "2026-10-25" }] },
        },
      },
      seen,
    );

    const result = await genericList(transport, GENERIC_READS.asana_list_tasks!, { connectedAccountId: "ca_1" });

    expect(seen[1]!.query).toMatchObject({ workspace: "ws-1", assignee: "me" });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.items[0]).toContain("Ship it");
  });

  it("asana fails honestly when the account has no workspace", async () => {
    const seen: TransportRequest[] = [];
    const transport = sequencedTransport(
      { "https://app.asana.com/api/1.0/users/me": { ok: true, status: 200, data: { data: { workspaces: [] } } } },
      seen,
    );

    const result = await genericList(transport, GENERIC_READS.asana_list_tasks!, { connectedAccountId: "ca_1" });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("workspace");
    expect(seen).toHaveLength(1);
  });

  it("canva maps the recorded Connect API item shape (top-level id)", async () => {
    // Recorded from the live API on the connected account, 2026-10-23.
    const transport = fakeTransport({
      ok: true,
      status: 200,
      data: {
        items: [
          {
            id: "DAHYbXUuHe0",
            title: "Pitch deck",
            owner: { user_id: "oUZXRA-GFRoe2D9ofIl7eE", team_id: "oBZXR0hMdLXDWjHKpyF6_4" },
          },
        ],
      },
    });

    const result = await genericList(transport, GENERIC_READS.canva_list_designs!, { connectedAccountId: "ca_1" });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.items[0]).toBe("Pitch deck — DAHYbXUuHe0");
  });
});

describe("GENERIC_READS integrity", () => {
  it("every spec's capability routes back through PROVIDER_TOOLS to itself", () => {
    for (const [tool, spec] of Object.entries(GENERIC_READS)) {
      const capability = CAPABILITIES[spec.capability as keyof typeof CAPABILITIES];
      expect(capability, `${tool} names unknown capability ${spec.capability}`).toBeDefined();
      expect(PROVIDER_TOOLS[capability.tool as keyof typeof PROVIDER_TOOLS], tool).toBe(spec.capability);
      expect(capability.tool, tool).toBe(tool);
    }
  });
});
