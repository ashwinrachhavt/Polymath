import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { GoogleEvent } from "@/domains/calendar/google-mapper";
import type { GoogleCalendarClient } from "@/integrations/google-calendar/client";
import { makeTestDb, seedWorkspace } from "../helpers/test-workspace";

const handle = makeTestDb();
const suite = handle ? describe : describe.skip;
const holder: { db: ReturnType<typeof drizzle> | undefined } = { db: undefined };
vi.mock("@/lib/db", () => ({ get db() { return holder.db; } }));
vi.mock("@/lib/db-transaction", () => ({
  get withTransaction() {
    return (fn: Parameters<typeof import("@/lib/db-transaction").withTransaction>[0]) =>
      (holder.db!.transaction as typeof import("@/lib/db-transaction").withTransaction)(fn);
  },
}));

import { syncGoogleCalendarAccount, GoogleSyncError } from "@/domains/calendar/google-sync";
import { events } from "@/domains/calendar/schema";
import { externalAccounts, syncCursors } from "@/domains/integrations/schema";

beforeAll(() => { holder.db = handle?.db; });
afterAll(async () => { await handle?.client.end(); });

const ev = (id: string, etag: string, hour: number, extra: Partial<GoogleEvent> = {}): GoogleEvent => ({
  id,
  etag,
  summary: `Event ${id}`,
  start: { dateTime: `2026-10-21T${String(hour).padStart(2, "0")}:00:00Z` },
  end: { dateTime: `2026-10-21T${String(hour + 1).padStart(2, "0")}:00:00Z` },
  ...extra,
});

function fake(batches: GoogleEvent[][], seen: Array<string | null>): GoogleCalendarClient {
  let i = 0;
  return {
    async listEventsUpdatedSince(updatedMin) {
      seen.push(updatedMin);
      return { events: batches[i++] ?? [], newestUpdated: `2026-10-0${i}T00:00:00.000Z`, truncated: false };
    },
  };
}

suite("google calendar sync", { timeout: 30_000 }, () => {
  it("creates, updates, cancels, stays idempotent, and advances the watermark", async () => {
    const a = await seedWorkspace(handle!.db, `gcal-${Date.now()}`);
    const auth = { userId: a.userId, workspaceId: a.workspaceId, role: "owner" as const };
    const [account] = await handle!.db
      .insert(externalAccounts)
      .values({ workspaceId: a.workspaceId, provider: "google-calendar", alias: "work", createdBy: a.userId, updatedBy: a.userId, status: "active" })
      .returning();
    const seen: Array<string | null> = [];
    const client = fake(
      [
        [ev("g1", "e1", 9), ev("g2", "e1", 11)],
        [ev("g1", "e1", 9), ev("g2", "e2", 11, { summary: "Renamed" })],
        [{ id: "g1", status: "cancelled" }],
      ],
      seen,
    );

    const first = await syncGoogleCalendarAccount(auth, { externalAccountId: account.id, client });
    expect(first).toMatchObject({ created: 2, updated: 0, cancelled: 0 });
    const second = await syncGoogleCalendarAccount(auth, { externalAccountId: account.id, client });
    expect(second).toMatchObject({ created: 0, updated: 1, unchanged: 1 });
    const third = await syncGoogleCalendarAccount(auth, { externalAccountId: account.id, client });
    expect(third.cancelled).toBe(1);

    const rows = await handle!.db.select().from(events).where(eq(events.workspaceId, a.workspaceId));
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.providerObjectId === "g2")?.title).toBe("Renamed");
    expect(rows.find((r) => r.providerObjectId === "g1")?.status).toBe("cancelled");

    expect(seen[0]).toBeNull();
    expect(seen[1]).toBe("2026-10-01T00:00:00.000Z");
    const [cursor] = await handle!.db
      .select()
      .from(syncCursors)
      .where(and(eq(syncCursors.externalAccountId, account.id), eq(syncCursors.resource, "events")));
    expect(cursor.cursor).toBe("2026-10-03T00:00:00.000Z");
  });

  it("refuses an account that is not a Google Calendar account of this workspace", async () => {
    const a = await seedWorkspace(handle!.db, `gcal-no-${Date.now()}`);
    const auth = { userId: a.userId, workspaceId: a.workspaceId, role: "owner" as const };
    await expect(
      syncGoogleCalendarAccount(auth, { externalAccountId: crypto.randomUUID(), client: fake([], []) }),
    ).rejects.toBeInstanceOf(GoogleSyncError);
  });
});
