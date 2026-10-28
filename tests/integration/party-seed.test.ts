import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { organizations, people } from "@/domains/identity/schema";
import type { PartySeed } from "@/domains/identity/party-seed";
import { makeTestDb, ownerAuth, seedWorkspace } from "../helpers/test-workspace";

/*
 * The party seed's merge rule, on real Postgres: email is the identity key
 * when the evidence gives an address, and name plus organization is the key
 * when it does not. A name alone never merges — two people called Chris at
 * two companies stay two people — and a re-run adds nothing.
 */

const handle = makeTestDb();
const suite = handle ? describe : describe.skip;
let db: NonNullable<typeof handle>["db"];
let seedParties: typeof import("@/domains/identity/party-seed").seedParties;

beforeAll(async () => {
  if (!handle) return;
  ({ db } = handle);
  // Imported after makeTestDb points DATABASE_URL at the scratch database,
  // because db-transaction.ts captures the URL at module load.
  ({ seedParties } = await import("@/domains/identity/party-seed"));
});

afterAll(async () => {
  await handle?.client.end();
});

function dataset(overrides: Partial<PartySeed> = {}): PartySeed {
  return {
    snapshotDate: "2026-10-27",
    timezone: "America/Los_Angeles",
    organizations: [
      { name: "Sierra", domain: "sierra.ai", summary: null },
      { name: "Axle", domain: "axleaccess.com", summary: null },
    ],
    people: [
      { name: "Jasmine Gonzales", email: "jasmine@sierra.ai", title: "Recruiting Coordinator", organization: "Sierra", summary: null },
      // No address, same name, two employers: evidence names people, not
      // identities, so these must never fold into one row.
      { name: "Chris", email: null, title: null, organization: "Sierra", summary: null },
      { name: "Chris", email: null, title: null, organization: "Axle", summary: null },
    ],
    ...overrides,
  };
}

suite("party seed", () => {
  it("merges on email, keeps a name-only person distinct per organization, and a re-run adds nothing", async () => {
    const { userId, workspaceId } = await seedWorkspace(db, `party-seed-${Date.now()}`);
    const auth = ownerAuth(userId, workspaceId);

    const first = await seedParties(auth, dataset(), { apply: true });
    expect(first.organizations.created).toBe(2);
    expect(first.people.created).toBe(3);
    expect(first.employments.created).toBe(3);

    const second = await seedParties(auth, dataset(), { apply: true });
    expect(second.organizations.created).toBe(0);
    expect(second.people.created).toBe(0);
    expect(second.people.matched).toBe(3);
    expect(second.employments.created).toBe(0);

    const rows = await db.select().from(people).where(eq(people.workspaceId, workspaceId));
    expect(rows).toHaveLength(3);
    expect(rows.filter((row) => row.displayName === "Chris")).toHaveLength(2);

    const orgs = await db.select().from(organizations).where(eq(organizations.workspaceId, workspaceId));
    expect(orgs).toHaveLength(2);
  });

  it("never claims a domain another organization already owns", async () => {
    const { userId, workspaceId } = await seedWorkspace(db, `party-domain-${Date.now()}`);
    const auth = ownerAuth(userId, workspaceId);

    await seedParties(
      auth,
      dataset({
        organizations: [
          { name: "Wellspring", domain: "withwellspring.com", summary: null },
          // A second org asserting the same domain: the unique index holds and
          // the seed records the evidence without stealing the claim.
          { name: "Abby Care", domain: "withwellspring.com", summary: null },
        ],
        people: [],
      }),
      { apply: true },
    );

    const orgs = await db.select().from(organizations).where(eq(organizations.workspaceId, workspaceId));
    expect(orgs.filter((org) => org.domain === "withwellspring.com")).toHaveLength(1);
    expect(orgs.find((org) => org.name === "Abby Care")?.domain).toBeNull();
  });
});
