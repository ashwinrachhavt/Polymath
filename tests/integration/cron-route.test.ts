import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { outboxEvents } from "@/domains/audit/schema";
import { makeTestDb, ownerAuth, seedWorkspace } from "../helpers/test-workspace";

/*
 * ASH-178: the scheduler trigger.
 *
 * The route is the deployed half of the drain; the local worker is the other.
 * What matters is that it is not an open endpoint and that it actually runs a
 * pass:
 *
 * - no bearer secret configured -> 404, so an unset secret does not advertise
 *   the endpoint to a scanner
 * - wrong bearer -> 401
 * - correct bearer -> recovered + claimed/dispatched counts, and the row moved
 */

const handle = makeTestDb();
const suite = handle ? describe : describe.skip;
let db: NonNullable<typeof handle>["db"];
let route: typeof import("@/app/api/internal/cron/route");
let outbox: typeof import("@/domains/audit/outbox");

const SECRET = "test-cron-secret";

beforeAll(async () => {
  if (!handle) return;
  ({ db } = handle);
  route = await import("@/app/api/internal/cron/route");
  outbox = await import("@/domains/audit/outbox");
});

afterAll(async () => {
  await handle?.client.end();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

function post(headers: Record<string, string> = {}) {
  return route.POST(new Request("http://localhost/api/internal/cron", { method: "POST", headers }));
}

async function seedPending(workspaceId: string) {
  return db.transaction((tx) =>
    outbox.enqueueOutbox(tx, { workspaceId }, { topic: "document.extraction_requested", payload: { documentId: null } }),
  );
}

suite("cron route (real Postgres)", () => {
  it("answers 404 when the dispatch secret is not configured", async () => {
    vi.stubEnv("OUTBOX_DISPATCH_SECRET", "");
    const response = await post({ authorization: `Bearer ${SECRET}` });
    expect(response.status).toBe(404);
  });

  it("answers 401 without the right bearer", async () => {
    vi.stubEnv("OUTBOX_DISPATCH_SECRET", SECRET);
    expect((await post()).status).toBe(401);
    expect((await post({ authorization: "Bearer wrong" })).status).toBe(401);
  });

  it("drains a pass and reports its counts", async () => {
    if (!handle) return;
    vi.stubEnv("OUTBOX_DISPATCH_SECRET", SECRET);
    vi.stubEnv("DATABASE_URL", process.env.TEST_DATABASE_URL!);
    await db.execute(sql`delete from outbox_events`);

    const seeded = await seedWorkspace(db, `cron-${Date.now()}`);
    void ownerAuth(seeded.userId, seeded.workspaceId);
    const enqueued = await seedPending(seeded.workspaceId);
    expect(enqueued.enqueued).toBe(true);

    const response = await post({ authorization: `Bearer ${SECRET}` });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({ recovered: 0, claimed: 1, dispatched: 1, failed: 0, dead: 0, reconciled: 0 });

    const [row] = await db.select().from(outboxEvents);
    expect(row.status).toBe("dispatched");
  });

  it("reports how many unknown attempts it settled", async () => {
    if (!handle) return;
    vi.stubEnv("OUTBOX_DISPATCH_SECRET", SECRET);
    vi.stubEnv("DATABASE_URL", process.env.TEST_DATABASE_URL!);
    await db.execute(sql`delete from outbox_events`);

    // A body counting 3 is the assertion: the route wires reconciliation into
    // the same pass. The sweep itself is proven in reconciliation.test.ts.
    const reconciliation = await import("@/domains/actions/reconciliation");
    const spy = vi
      .spyOn(reconciliation, "reconcileUnknownAttempts")
      .mockResolvedValue({ reconciled: 3 });
    try {
      const response = await post({ authorization: `Bearer ${SECRET}` });
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.reconciled).toBe(3);
      expect(spy).toHaveBeenCalledOnce();
    } finally {
      spy.mockRestore();
    }
  });

  /*
   * ASH-189. Vercel Cron calls the path with GET and signs with CRON_SECRET;
   * it never sends OUTBOX_DISPATCH_SECRET. Before this, the schedule existed in
   * vercel.json but the route answered POST only, so every scheduled tick would
   * have 405'd while the deployment looked healthy.
   */
  it("accepts a GET signed with CRON_SECRET, which is how Vercel Cron calls it", async () => {
    if (!handle) return;
    vi.stubEnv("OUTBOX_DISPATCH_SECRET", "");
    vi.stubEnv("CRON_SECRET", "vercel-cron-secret");
    vi.stubEnv("DATABASE_URL", process.env.TEST_DATABASE_URL!);
    await db.execute(sql`delete from outbox_events`);
    const seeded = await seedWorkspace(db, `cron-get-${Date.now()}`);
    await seedPending(seeded.workspaceId);

    const response = await route.GET(
      new Request("http://localhost/api/internal/cron", {
        method: "GET",
        headers: { authorization: "Bearer vercel-cron-secret" },
      }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ dispatched: 1 });
  });

  it("still refuses a GET whose bearer matches neither secret", async () => {
    vi.stubEnv("CRON_SECRET", "vercel-cron-secret");
    const response = await route.GET(
      new Request("http://localhost/api/internal/cron", {
        method: "GET",
        headers: { authorization: "Bearer wrong" },
      }),
    );
    expect(response.status).toBe(401);
  });

  it("answers 404 on GET when no secret is configured at all", async () => {
    vi.stubEnv("OUTBOX_DISPATCH_SECRET", "");
    vi.stubEnv("CRON_SECRET", "");
    const response = await route.GET(new Request("http://localhost/api/internal/cron", { method: "GET" }));
    expect(response.status).toBe(404);
  });
});
