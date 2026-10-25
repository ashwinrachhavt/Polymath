import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { makeTestDb, seedWorkspace } from "../helpers/test-workspace";
import { sql } from "drizzle-orm";

// Hoisted: swaps the registry's providerEntry for one whose composio entry is
// unverified, restoring the real one after. Used only by the registry-gate test.
const registryGate = vi.hoisted(() => ({
  unverified: false,
}));

vi.mock("@/integrations/providers/registry", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/integrations/providers/registry")>();
  return {
    ...actual,
    providerEntry: (id: string) => {
      const entry = actual.providerEntry(id);
      if (!registryGate.unverified || id !== "composio" || !entry) return entry;
      return { ...entry, verifiedAt: null, verificationSource: null };
    },
  };
});

/*
 * Instant-tools invariants. The spend-guard atomicity and ledger rows live in
 * real Postgres (they extend the provider-quota invariant suite); the gate
 * order and refusal taxonomy are proven with stubbed fetches because the
 * point is what happens BEFORE any request leaves the process.
 *
 * Postgres-dependent tests skip locally without TEST_DATABASE_URL; CI treats
 * the missing database as a broken gate (tests/helpers/test-workspace.ts).
 */

const handle = makeTestDb();
const suite = handle ? describe : describe.skip;

let db: NonNullable<typeof handle>["db"];
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let quota: any;

beforeAll(async () => {
  if (!handle) return;
  ({ db } = handle);
  quota = await import("@/integrations/providers/quota");
});

afterAll(async () => {
  await handle?.client.end();
});

// Hoisted: lets a single test replace withQuota's store (the provider-error
// mapping test runs outside Postgres; atomicity is proven in the suite below).
const quotaSeam = vi.hoisted(() => ({
  passthrough: true,
}));

vi.mock("@/integrations/providers/quota", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/integrations/providers/quota")>();
  return {
    ...actual,
    withQuota: ((...args: Parameters<typeof actual.withQuota>) => {
      if (!quotaSeam.passthrough) return args[4]();
      return actual.withQuota(...args);
    }) as typeof actual.withQuota,
  };
});

beforeEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  resetInstantListCache();
  quotaSeam.passthrough = true;
  // The deployment is "configured" in tests: the API key travels through the
  // env like production, so the not-configured fail-closed path stays testable
  // by explicitly stubbing it away.
  vi.stubEnv("COMPOSIO_API_KEY", "test-key");
});

import {
  InstantToolNotExecutableError,
  deriveInstantCapability,
  executeInstantTool,
  listInstantTools,
  resetInstantListCache,
  resolveInstantCapability,
  seedInstantListCacheForTest as listCacheSeedForTest,
} from "@/domains/integrations/instant-tools";
import { providerEntry } from "@/integrations/providers/registry";

function stubFetchOnce(status: number, body: unknown) {
  return vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify(body), { status })),
  );
}

describe("deriveInstantCapability / resolveInstantCapability", () => {
  it("derives and round-trips a capability name", () => {
    const name = deriveInstantCapability("granola", "GRANOLA_FETCH_USERS");
    expect(name).toBe("instant.granola.granola_fetch_users");
    expect(resolveInstantCapability(name)).toEqual({ toolkitSlug: "granola" });
  });

  it("collapses non-alphanumerics and trims underscores", () => {
    expect(deriveInstantCapability("google-drive", "DRIVE--files::list")).toBe(
      "instant.google-drive.drive_files_list",
    );
  });

  it("returns null for non-instant names and unknown toolkits", () => {
    expect(resolveInstantCapability("gmail_search")).toBeNull();
    expect(resolveInstantCapability("instant.nosuchtool.thing")).toBeNull();
  });

  it("pins the registry values the guard depends on (T1 deferred minor)", () => {
    const entry = providerEntry("composio");
    expect(entry?.quota?.unit).toBe("requests");
    expect(entry?.quota?.allowanceEnv).toBe("COMPOSIO_MONTHLY_TOOL_CALLS");
    expect(entry?.verifiedAt).not.toBeNull();
  });
});

describe("executeInstantTool gates (no fetch on refusal)", () => {
  it("refuses registry_unverified before any fetch", async () => {
    const fetchSpy = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);
    registryGate.unverified = true;
    try {
      await expect(
        executeInstantTool({ toolSlug: "instant.granola.granola_fetch_users", args: {}, workspaceId: "00000000-0000-0000-0000-000000000000" }),
      ).rejects.toMatchObject({ reason: "registry_unverified" });
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      registryGate.unverified = false;
      vi.unstubAllGlobals();
      resetInstantListCache();
    }
  });

  it("refuses not_no_auth when the cached catalog says the tool is not no_auth", async () => {
    // Cache a catalog where the tool exists but noAuth is false.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({ items: [{ slug: "GRANOLA_FETCH_USERS", name: "Fetch users", no_auth: false }] }),
          { status: 200 },
        ),
      ),
    );
    await listInstantTools("granola");
    const fetchSpy = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);
    await expect(
      executeInstantTool({ toolSlug: "instant.granola.granola_fetch_users", args: {}, workspaceId: "00000000-0000-0000-0000-000000000000" }),
    ).rejects.toMatchObject({ reason: "not_no_auth" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("refuses write_unverified when the catalog has not proven the tool read-only", async () => {
    // A tool the generated JSON does not classify carries no read proof, so
    // the live-cached descriptor is unverified even though the API says
    // no_auth true. The stub returns such a tool; execute must refuse before
    // any spend or second fetch.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({ items: [{ slug: "GRANOLA_UNKNOWN_TOOL", name: "Unknown", no_auth: true }] }),
          { status: 200 },
        ),
      ),
    );
    await listInstantTools("granola");
    const fetchSpy = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);
    await expect(
      executeInstantTool({ toolSlug: "instant.granola.granola_unknown_tool", args: {}, workspaceId: "00000000-0000-0000-0000-000000000000" }),
    ).rejects.toMatchObject({ reason: "write_unverified" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("listInstantTools cache behavior", () => {
  it("serves the stale cache when a later fetch fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({ items: [{ slug: "GRANOLA_FETCH_USERS", name: "Fetch users", no_auth: true }] }),
          { status: 200 },
        ),
      ),
    );
    const first = await listInstantTools("granola");
    expect(first).toHaveLength(1);
    vi.stubGlobal("fetch", vi.fn(async () => new Response("boom", { status: 500 })));
    const second = await listInstantTools("granola");
    expect(second).toEqual(first);
  });

  it("throws when there is no cached copy and the fetch fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("boom", { status: 500 })));
    await expect(listInstantTools("granola")).rejects.toThrow(/unreachable/);
  });
});

describe("executeInstantTool provider error mapping", () => {
  it("maps a 429 to provider_error with the status", async () => {
    // Runs without Postgres: withQuota is asked to passthrough (the atomicity
    // suite below proves the real reserve/settle against a real database).
    quotaSeam.passthrough = false;
    // The generated JSON classifies granola's tool as a proven read, so a
    // cache fed from the generated catalog lets the gates pass and the
    // (stubbed) execute call return 429.
    listCacheSeedForTest("granola", [
      { slug: "GRANOLA_FETCH_USERS", name: "Fetch users", noAuth: true, riskClass: "read" },
    ]);
    stubFetchOnce(429, { message: "rate limited" });
    const result = await executeInstantTool({
      toolSlug: "instant.granola.granola_fetch_users",
      args: {},
      workspaceId: "00000000-0000-0000-0000-000000000000",
      apiKey: "test-key",
    });
    expect(result).toMatchObject({ ok: false, code: "provider_error", status: 429 });
  });
});

suite("executeInstantTool spend-guard atomicity (real Postgres)", () => {
  it("writes reserve+settle ledger rows on success", async () => {
    const { workspaceId } = await seedWorkspace(db, `instant-settle-${Date.now()}-${process.pid}`);
    listCacheSeedForTest("granola", [
      { slug: "GRANOLA_FETCH_USERS", name: "Fetch users", noAuth: true, riskClass: "read" },
    ]);
    stubFetchOnce(200, { data: { ok: true } });
    const result = await executeInstantTool({
      toolSlug: "instant.granola.granola_fetch_users",
      args: {},
      workspaceId,
      apiKey: "test-key",
      // The test DB handle, not the module-level one (which bound DATABASE_URL
      // at import time, before the helper could point it at TEST_DATABASE_URL).
      quotaStore: quota.drizzleQuotaStore(db),
    });
    expect(result).toMatchObject({ ok: true });
    const ledger = await db.execute(sql`
      SELECT kind FROM provider_usage_ledger l
      JOIN provider_quota_buckets b ON b.id = l.bucket_id
      WHERE b.workspace_id = ${workspaceId}::uuid AND b.provider = 'composio'
      ORDER BY l.created_at, kind
    `);
    expect((ledger as unknown as Array<{ kind: string }>).map((r) => r.kind)).toEqual(["reserve", "settle"]);
    const bucket = await db.execute(sql`
      SELECT reserved, consumed FROM provider_quota_buckets
      WHERE workspace_id = ${workspaceId}::uuid AND provider = 'composio'
    `);
    expect((bucket as unknown as Array<{ reserved: number; consumed: number }>)[0]).toMatchObject({
      reserved: 0,
      consumed: 1,
    });
  });

  it("releases the reservation when execute throws", async () => {
    const { workspaceId } = await seedWorkspace(db, `instant-release-${Date.now()}-${process.pid}`);
    listCacheSeedForTest("granola", [
      { slug: "GRANOLA_FETCH_USERS", name: "Fetch users", noAuth: true, riskClass: "read" },
    ]);
    // Network failure inside the guarded call: withQuota must release.
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("socket died"); }));
    const result = await executeInstantTool({
      toolSlug: "instant.granola.granola_fetch_users",
      args: {},
      workspaceId,
      apiKey: "test-key",
      quotaStore: quota.drizzleQuotaStore(db),
    });
    expect(result).toMatchObject({ ok: false, code: "provider_error" });
    const bucket = await db.execute(sql`
      SELECT reserved, consumed FROM provider_quota_buckets
      WHERE workspace_id = ${workspaceId}::uuid AND provider = 'composio'
    `);
    expect((bucket as unknown as Array<{ reserved: number; consumed: number }>)[0]).toMatchObject({
      reserved: 0,
      consumed: 0,
    });
  });
});
