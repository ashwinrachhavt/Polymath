import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import { externalAccounts } from "@/domains/integrations/schema";
import type { GoogleCalendarClient } from "@/integrations/google-calendar/client";
import { makeTestDb, seedWorkspace } from "../helpers/test-workspace";

/*
 * getTodayAgenda — the briefing's read-only view of today's calendar.
 *
 * Value card
 * protects: the named-state contract the spec asks for: no account reads as
 *   "not_connected", a connected-but-id-less account reads as "unconfigured",
 *   a provider failure reads as "unavailable" with a reason, and a successful
 *   read with zero events stays a real "ok" (a genuinely free day can never
 *   masquerade as a failure, and vice versa). One account's failure never
 *   swallows another account's events, and only this workspace's active
 *   Google Calendar accounts are read.
 * fails_when: any failure path returns an empty events list (the panel would
 *   show "nothing today" while the calendar is broken), a thrown provider
 *   error aborts the whole agenda, or a "connecting"/other-provider account
 *   is treated as readable.
 * why_new: the function is new; every contract above is a database/provider
 *   behavior no existing test covers.
 * seam: the exported orchestrator against real Postgres, with a fake Google
 *   client (the account selection and tz lookup are database facts; the
 *   provider is out of process).
 */

const handle = makeTestDb();
const suite = handle ? describe : describe.skip;
const holder: { db: ReturnType<typeof drizzle> | undefined } = { db: undefined };

vi.mock("@/lib/db", () => ({ get db() { return holder.db; } }));

import { getTodayAgenda } from "@/domains/integrations/calendar-agenda";

let a: { userId: string; workspaceId: string };
let b: { userId: string; workspaceId: string };
const ctx = (w: { userId: string; workspaceId: string }) => ({ ...w, role: "owner" as const });
const NOW = new Date("2026-10-23T18:00:00Z");

const client = (events: object[] | Error, truncated = false): GoogleCalendarClient => ({
  async listEventsUpdatedSince() {
    if (events instanceof Error) throw events;
    return { events: events as never, newestUpdated: null, truncated };
  },
});

beforeAll(async () => {
  holder.db = handle?.db;
  a = await seedWorkspace(handle!.db, `agenda-${crypto.randomUUID()}`);
  b = await seedWorkspace(handle!.db, `agenda-${crypto.randomUUID()}`);
  await handle!.db.insert(externalAccounts).values([
    // Two readable Google Calendar accounts in workspace a (work + personal),
    // plus one without a Composio id, plus one still connecting.
    { workspaceId: a.workspaceId, provider: "google-calendar", alias: "work-cal", status: "active", composioConnectedAccountId: `ca_${crypto.randomUUID()}` },
    { workspaceId: a.workspaceId, provider: "google-calendar", alias: "personal-cal", status: "active", composioConnectedAccountId: `ca_${crypto.randomUUID()}` },
    { workspaceId: a.workspaceId, provider: "google-calendar", alias: "pending-cal", status: "active", composioConnectedAccountId: null },
    { workspaceId: a.workspaceId, provider: "google-calendar", alias: "connecting-cal", status: "connecting" },
    // Not calendar accounts / not this workspace: must never be read.
    { workspaceId: a.workspaceId, provider: "gmail", alias: "work-gmail", status: "active", composioConnectedAccountId: `ca_${crypto.randomUUID()}` },
    { workspaceId: b.workspaceId, provider: "google-calendar", alias: "other-cal", status: "active", composioConnectedAccountId: `ca_${crypto.randomUUID()}` },
  ]);
});
afterAll(async () => { await handle?.client.end(); });

suite("getTodayAgenda (real Postgres)", () => {
  it("reports not_connected for a workspace with no active Google Calendar account", async () => {
    // Workspace b's only calendar account is ignored... via ctx(b)? b has one active account.
    // Use a fresh workspace with no accounts at all.
    const empty = await seedWorkspace(handle!.db, `agenda-empty-${crypto.randomUUID()}`);
    expect(await getTodayAgenda(ctx(empty), { now: NOW })).toEqual({ status: "not_connected" });
  });

  it("reads per-account: events, a free day, unconfigured; one failure is named and never hides the rest", async () => {
    const seenWindows: Record<string, { timeMin: string; timeMax: string } | undefined> = {};
    // Drive the client by the real seeded account ids.
    const rows = await handle!.db.select().from(externalAccounts);
    const byAlias = new Map(rows.map((r) => [r.alias, r.composioConnectedAccountId]));
    const workId = byAlias.get("work-cal")!;
    const personalId = byAlias.get("personal-cal")!;
    const clientFor = (id: string): GoogleCalendarClient => ({
      async listEventsUpdatedSince(_updatedMin, window) {
        seenWindows[id] = window;
        if (id === personalId) throw new Error("Google Calendar read failed (HTTP 500).");
        if (id === workId) {
          return { events: [
            { id: "e1", status: "confirmed", summary: "Design review", start: { dateTime: "2026-10-23T16:00:00Z" }, end: { dateTime: "2026-10-23T17:00:00Z" } },
            { id: "e2", status: "cancelled", summary: "Ghost", start: { dateTime: "2026-10-23T18:00:00Z" } },
          ], newestUpdated: null, truncated: false } as never;
        }
        return { events: [], newestUpdated: null, truncated: false };
      },
    });

    const result = await getTodayAgenda(ctx(a), { now: NOW, clientFor });
    expect(result.status).toBe("connected");
    if (result.status !== "connected") return;
    expect(result.day).toMatch(/^2026-10-2[23]$/);
    expect(result.timezone).toBeTruthy();
    expect(result.asOf).toBe(NOW.toISOString());

    const byStatus = new Map(result.accounts.map((acc) => [acc.alias, acc]));
    // work-cal: one live event, the cancelled one dropped.
    expect(byStatus.get("work-cal")).toMatchObject({ status: "ok", events: [{ id: "e1", title: "Design review", allDay: false }] });
    // personal-cal: provider failure is named, never a silent empty list.
    expect(byStatus.get("personal-cal")).toEqual({ status: "unavailable", alias: "personal-cal", reason: "Google Calendar could not be read (HTTP 500)." });
    // pending-cal: account exists, no Composio connection yet.
    expect(byStatus.get("pending-cal")).toEqual({ status: "unconfigured", alias: "pending-cal" });
    // connecting, other-provider, and other-workspace accounts are never read.
    expect(result.accounts.map((acc) => acc.alias).sort()).toEqual(["pending-cal", "personal-cal", "work-cal"]);

    // The read window is today's local bounds (seeded workspaces default to UTC).
    expect(seenWindows[workId]).toEqual({ timeMin: "2026-10-23T00:00:00.000Z", timeMax: "2026-10-24T00:00:00.000Z" });
  });

  it("reports a truncated read and a credential-carrying error as named unavailability, never ok", async () => {
    const solo = await seedWorkspace(handle!.db, `agenda-tr-${crypto.randomUUID()}`);
    await handle!.db.insert(externalAccounts).values([
      { workspaceId: solo.workspaceId, provider: "google-calendar", alias: "busy-cal", status: "active", composioConnectedAccountId: `ca_${crypto.randomUUID()}` },
      { workspaceId: solo.workspaceId, provider: "google-calendar", alias: "leaky-cal", status: "active", composioConnectedAccountId: `ca_${crypto.randomUUID()}` },
    ]);
    const rows = await handle!.db.select().from(externalAccounts);
    const busyId = rows.find((r) => r.alias === "busy-cal")!.composioConnectedAccountId!;
    const result = await getTodayAgenda(ctx(solo), {
      now: NOW,
      clientFor: (id) => id === busyId
        ? client([{ id: "e1", start: { date: "2026-10-23" } }], true)
        : client(new Error("Request failed for ca_secret with access_token=ya29.leaked: 401 invalid_token")),
    });
    expect(result.status).toBe("connected");
    if (result.status !== "connected") return;
    const byAlias = new Map(result.accounts.map((acc) => [acc.alias, acc]));
    expect(byAlias.get("busy-cal")).toEqual({ status: "unavailable", alias: "busy-cal", reason: "This calendar has more events today than can be shown." });
    expect(byAlias.get("leaky-cal")).toEqual({ status: "unavailable", alias: "leaky-cal", reason: "Google Calendar could not be read." });
  });

  it("reports a genuinely free day as ok with zero events", async () => {
    const solo = await seedWorkspace(handle!.db, `agenda-solo-${crypto.randomUUID()}`);
    // Composio ids are globally unique (external_accounts_composio_key).
    await handle!.db.insert(externalAccounts).values({ workspaceId: solo.workspaceId, provider: "google-calendar", alias: "only-cal", status: "active", composioConnectedAccountId: `ca_${crypto.randomUUID()}` });
    const result = await getTodayAgenda(ctx(solo), { now: NOW, clientFor: () => client([]) });
    expect(result).toMatchObject({ status: "connected", accounts: [{ status: "ok", alias: "only-cal", calendar: "primary", events: [] }] });
  });
});
