import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ownerAuth, seedWorkspace } from "../helpers/test-workspace";

/*
 * The settings API-keys actions against the pre-0234 schema (production
 * today: api_clients has no key_id column): the action must answer the
 * driver error with its generic message, never the raw failed-query dump.
 *
 * Isolation: the suite builds a dedicated scratch SCHEMA holding only a
 * minimal pre-0234 api_clients (no key_id), puts it first on its own
 * connection's search_path, and drops the schema afterwards. Shared tables
 * are never altered or locked; seeding still lands in public via
 * search_path fallback. The single-connection client guarantees the
 * search_path setting and the action share one session.
 */

const url = process.env.TEST_DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("CI must provide TEST_DATABASE_URL: the integration suites cannot silently skip.");
}
const suite = url ? describe : describe.skip;

const client = url ? postgres(url, { max: 1 }) : undefined;
const schema = `axiom_iso_${Date.now()}`;
const holder: { db: unknown } = { db: undefined };
vi.mock("@/lib/db", () => ({ get db() { return holder.db; } }));

const getAuthContext = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/auth")>();
  return { ...original, getAuthContext };
});

import { listApiKeysAction } from "@/app/(workspace)/settings/api-key-actions";

suite("API keys against the pre-0234 schema (dedicated scratch schema)", () => {
  beforeAll(async () => {
    holder.db = drizzle(client!);
    const { userId, workspaceId } = await seedWorkspace(holder.db as never, `degraded-api-keys-${Date.now()}`);
    getAuthContext.mockResolvedValue(ownerAuth(userId, workspaceId));
    await client!.unsafe(`CREATE SCHEMA ${schema}`);
    await client!.unsafe(`CREATE TABLE ${schema}.api_clients (id uuid primary key)`);
    await client!.unsafe(`SET search_path TO ${schema}, public`);
  });

  afterAll(async () => {
    await client!.unsafe(`DROP SCHEMA ${schema} CASCADE`);
    // The shared table is untouched: key_id still exists in public.
    const rows = await client!.unsafe(
      "SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'api_clients' AND column_name = 'key_id'",
    );
    expect(rows).toHaveLength(1);
    await client!.end();
  });

  it("answers the missing key_id column with the generic message, no SQL", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const result = await listApiKeysAction();

    expect(result).toEqual({ ok: false, error: "Could not load API keys." });
    expect(JSON.stringify(result)).not.toContain("Failed query");
    expect(JSON.stringify(result)).not.toContain("api_clients");
    expect(JSON.stringify(result)).not.toContain("key_id");
    // The log captured the standard SQLSTATE for the missing column (drizzle rethrows as a plain Error with the driver code attached).
    expect(spy.mock.calls[0]).toEqual([
      "[action]",
      "Could not load API keys.",
      { name: "Error", code: "42703" },
    ]);
    spy.mockRestore();
  });
});
