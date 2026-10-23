import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  CAPABILITIES,
  PROVIDER_TIERS,
  lowestTierId,
  tierAllows,
  tierCapabilities,
  type Provider,
} from "@/domains/integrations/capabilities";

/*
 * The tier capability lists in PROVIDER_TIERS are the enforcement source: what
 * a tier names is what an agent on that tier can do. These tests pin the two
 * ways that list can rot — a capability id that no longer exists in the
 * catalog, and a tier ladder that stops extending — plus the drift between
 * this module and migration 0229, which seeds the same JSON for the connect
 * screen.
 */

const migrationSql = [
  "0229_access_tiers.sql",
  "0230_google_tiers.sql",
  "0231_comms_tiers.sql",
  "0232_workmgmt_tiers.sql",
  "0233_crm_tiers.sql",
  "0238_notion_access_tiers.sql",
]
  .map((file) => readFileSync(new URL(`../../src/db/migrations/${file}`, import.meta.url), "utf8"))
  .join("\n");

/** Pulls the access_tiers JSON literal the migration seeds for one provider. */
function seededTiers(provider: string): unknown {
  const match = migrationSql.match(
    new RegExp(`'(\\[.*?\\])'::jsonb\\s+WHERE provider = '${provider}'`),
  );
  expect(match, `the tier migrations have no JSON seed for ${provider}`).toBeDefined();
  return JSON.parse(match![1]);
}

describe("PROVIDER_TIERS", () => {
  it("offers a tier to every provider in the catalog", () => {
    const providers = new Set(
      Object.values(CAPABILITIES).map((spec) => spec.provider),
    );
    for (const provider of providers) {
      expect(PROVIDER_TIERS[provider].length, provider).toBeGreaterThan(0);
    }
  });

  it("names only capabilities that exist in the catalog", () => {
    for (const [provider, tiers] of Object.entries(PROVIDER_TIERS)) {
      for (const tier of tiers) {
        for (const capability of tier.capabilities) {
          expect(
            capability in CAPABILITIES,
            `${provider}/${tier.id} names unknown capability ${capability}`,
          ).toBe(true);
        }
      }
    }
  });

  it("tiers are ordered lowest-first and strictly extending", () => {
    for (const [provider, tiers] of Object.entries(PROVIDER_TIERS)) {
      for (let i = 1; i < tiers.length; i++) {
        // Each rung is a superset of the one below: it adds, never reshuffles.
        const upper = tiers[i].capabilities;
        for (const capability of tiers[i - 1].capabilities) {
          expect(upper.includes(capability), `${provider} tier ${i}`).toBe(true);
        }
        expect(upper.length, provider).toBeGreaterThan(
          tiers[i - 1].capabilities.length,
        );
      }
    }
  });

  it("keeps the gmail ladder to read, then read + send proposals", () => {
    expect(PROVIDER_TIERS.gmail.map((tier) => tier.id)).toEqual([
      "read_only",
      "read_send",
    ]);
  });
});

describe("tier helpers", () => {
  it("tierAllows denies above the tier", () => {
    expect(tierAllows("gmail", "read_only", "gmail.send")).toBe(false);
    expect(tierAllows("gmail", "read_send", "gmail.send")).toBe(true);
    expect(tierAllows("gmail", "read_only", "gmail.read")).toBe(true);
  });

  it("tierAllows fails closed for unknown tier ids", () => {
    expect(tierAllows("gmail", "admin", "gmail.read")).toBe(false);
    expect(tierCapabilities("gmail", "admin")).toEqual([]);
  });

  it("tierCapabilities returns the tier's list", () => {
    expect(tierCapabilities("gmail", "read_only")).toEqual([
      "gmail.read",
      "gmail.thread.read",
    ]);
  });

  it("lowestTierId is the first tier, null when a provider has none", () => {
    expect(lowestTierId("gmail")).toBe("read_only");
    expect(lowestTierId("github")).toBe("read_only");
    // Every union member ships tiers now, so the null path is reached only
    // through a cast of a catalogue provider outside the union, like jira.
    const jira = "jira" as Provider;
    expect(lowestTierId(jira)).toBeNull();
  });

  it("notion ships one read_only tier over its search and page read", () => {
    expect(PROVIDER_TIERS.notion.map((t) => t.id)).toEqual(["read_only"]);
    expect(tierCapabilities("notion", "read_only")).toEqual(["notion.read", "notion.page.read"]);
  });
});


describe("PROVIDER_TIERS google cluster", () => {
  it("covers google-calendar and google-drive with one read_only tier", () => {
    for (const provider of ["google-calendar", "google-drive"] as Provider[]) {
      expect(PROVIDER_TIERS[provider].map((t) => t.id), provider).toEqual(["read_only"]);
    }
  });

  it("docs, sheets, jira and salesforce have no tiers — their list reads are not GET-expressible", () => {
    // These providers stay in the catalog (rows exist) but outside the Provider
    // union: no shipped capability, so no tier offer. Coming soon, honestly.
    const catalog = ["0031_seed_integration_catalog.sql", "0223_connector_catalog_expansion.sql"]
      .map((file) => readFileSync(new URL(`../../src/db/migrations/${file}`, import.meta.url), "utf8"))
      .join("\n");
    for (const provider of ["google-docs", "google-sheets", "jira", "salesforce"]) {
      expect(catalog.includes(`'${provider}'`), provider).toBe(true);
      expect(provider in PROVIDER_TIERS, provider).toBe(false);
    }
  });

  it("each google read_only tier names only real capabilities", () => {
    for (const provider of ["google-calendar", "google-drive"] as Provider[]) {
      for (const capability of PROVIDER_TIERS[provider][0].capabilities) {
        expect(capability in CAPABILITIES, `${provider} names ${capability}`).toBe(true);
      }
    }
  });
});


describe("PROVIDER_TIERS comms cluster", () => {
  it("covers discord, zoom, calendly with one read_only tier", () => {
    for (const provider of ["discord", "zoom", "calendly"] as Provider[]) {
      expect(PROVIDER_TIERS[provider].map((t) => t.id), provider).toEqual(["read_only"]);
    }
  });
});


describe("PROVIDER_TIERS work-management cluster", () => {
  it("covers asana, trello, airtable with one read_only tier", () => {
    for (const provider of ["asana", "trello", "airtable"] as Provider[]) {
      expect(PROVIDER_TIERS[provider].map((t) => t.id), provider).toEqual(["read_only"]);
    }
  });
});


describe("PROVIDER_TIERS crm/finance cluster", () => {
  it("covers canva, hubspot, stripe with one read_only tier", () => {
    for (const provider of ["canva", "hubspot", "stripe"] as Provider[]) {
      expect(PROVIDER_TIERS[provider].map((t) => t.id), provider).toEqual(["read_only"]);
    }
  });

  it("stripe's tier description says charges are never agent-proposed", () => {
    expect(PROVIDER_TIERS.stripe[0].description).toContain("never agent-proposed");
  });
});

describe("drift between PROVIDER_TIERS and migration 0229", () => {
  it("the gmail tier JSON matches the seed verbatim", () => {
    expect(seededTiers("gmail")).toEqual(
      JSON.parse(JSON.stringify(PROVIDER_TIERS.gmail)),
    );
  });

  it("every provider's tier JSON matches its seed", () => {
    for (const [provider, tiers] of Object.entries(PROVIDER_TIERS)) {
      expect(seededTiers(provider), provider).toEqual(
        JSON.parse(JSON.stringify(tiers)),
      );
    }
  });
});
