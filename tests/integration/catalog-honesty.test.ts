import { readFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { CAPABILITIES, PROVIDER_TOOLS } from "@/domains/integrations/capabilities";
import { integrationCatalog } from "@/domains/integrations/schema";
import { db } from "@/lib/db";
import { makeTestDb } from "../helpers/test-workspace";

/*
 * The closing net over the connector catalog: what the connect screen offers
 * must be what the gateway can route. A tier naming a capability the catalog
 * does not know, or a tool the gateway cannot dispatch, is a card that
 * promises something the product cannot do — the exact dishonesty this plan
 * was written to remove.
 */

const handle = makeTestDb();
const suite = handle ? describe : describe.skip;
const holder: { db: NonNullable<ReturnType<typeof makeTestDb>>["db"] | undefined } = { db: undefined };
vi.mock("@/lib/db", () => ({ get db() { return holder.db!; } }));

type Tier = { id: string; label: string; description: string; capabilities: string[] };

/** The migration harness applies SQL files directly; drizzle's journal is stale (see ledger). */
beforeAll(async () => {
  if (!handle) return;
  holder.db = handle.db;
  // 0223 seeds the catalog rows the tier files update. Several sibling suites
  // truncate the shared test database, so this suite re-applies the seed too:
  // an UPDATE with no row behind it is the flake this guards against.
  for (const file of ["0223_connector_catalog_expansion.sql", "0229_access_tiers.sql", "0230_google_tiers.sql", "0231_comms_tiers.sql", "0232_workmgmt_tiers.sql", "0233_crm_tiers.sql"]) {
    await handle.client.unsafe(readFileSync(`src/db/migrations/${file}`, "utf8"));
  }
});

afterAll(async () => {
  await handle?.client.end();
});

suite("catalog honesty", () => {
  it("every catalog provider with tiers can route its lowest tier", async () => {
    const rows = await db.select().from(integrationCatalog);
    const tiered = rows.filter((row) => (row.accessTiers as Tier[]).length > 0);
    expect(tiered.length).toBeGreaterThan(0);
    for (const row of tiered) {
      const tiers = row.accessTiers as Tier[];
      for (const capability of tiers[0].capabilities) {
        const spec = CAPABILITIES[capability as keyof typeof CAPABILITIES];
        expect(spec, `${row.provider} tier names unknown capability ${capability}`).toBeDefined();
        expect(PROVIDER_TOOLS[spec.tool as keyof typeof PROVIDER_TOOLS], `${capability} has no tool mapping`).toBe(capability);
        expect(["read", "proposal"], `${capability} has an unrouteable kind`).toContain(spec.kind);
      }
    }
  });

  it("every catalog provider is either connectable or explicitly coming soon", async () => {
    const rows = await db.select().from(integrationCatalog);
    for (const row of rows) {
      const tiers = row.accessTiers as Tier[];
      expect(Array.isArray(tiers), `${row.provider} has a non-array access_tiers`).toBe(true);
      if (tiers.length > 0) {
        for (const tier of tiers) {
          expect(tier.id, `${row.provider} tier missing id`).toBeTruthy();
          expect(tier.capabilities.length, `${row.provider}/${tier.id} grants nothing`).toBeGreaterThan(0);
        }
      }
    }
  });

  it("gmail keeps two tiers and stripe stays read-only", async () => {
    const [gmail] = await db.select().from(integrationCatalog).where(eq(integrationCatalog.provider, "gmail"));
    expect((gmail.accessTiers as Tier[]).map((tier) => tier.id)).toEqual(["read_only", "read_send"]);

    const [stripe] = await db.select().from(integrationCatalog).where(eq(integrationCatalog.provider, "stripe"));
    const tiers = stripe.accessTiers as Tier[];
    expect(tiers.map((tier) => tier.id)).toEqual(["read_only"]);
    expect(tiers[0].description).toContain("never agent-proposed");
    expect(tiers[0].capabilities).toEqual(["stripe.payments.read"]);
  });
});
