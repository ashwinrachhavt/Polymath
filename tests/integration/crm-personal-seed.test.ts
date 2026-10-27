import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { companies, contacts } from "@/domains/crm/schema";
import type { PersonalSeed } from "@/domains/crm/seed";
import { events, eventLinks } from "@/domains/calendar/schema";
import { makeTestDb, ownerAuth, seedWorkspace } from "../helpers/test-workspace";

/*
 * The personal seed's real-Postgres invariants: a re-run adds nothing, an
 * owner edit survives, a domain another company already owns is not stolen,
 * and a cancelled event stays cancelled rather than being promoted.
 */

const handle = makeTestDb();
const suite = handle ? describe : describe.skip;
let db: NonNullable<typeof handle>["db"];
// Imported after makeTestDb points DATABASE_URL at the scratch database, because
// db-transaction.ts captures the URL at module load (same reason party-import
// imports dynamically).
let seedPersonalData: typeof import("@/domains/crm/seed").seedPersonalData;
let zonedToUtc: typeof import("@/domains/crm/seed").zonedToUtc;

beforeAll(async () => {
  // The pure DST test runs even when the database suites skip. makeTestDb
  // already selected the scratch URL above, before this module is loaded.
  ({ seedPersonalData, zonedToUtc } = await import("@/domains/crm/seed"));
  if (handle) ({ db } = handle);
});

afterAll(async () => {
  await handle?.client.end();
});

const SNAPSHOT = "2026-10-18";

function dataset(overrides: Partial<PersonalSeed> = {}): PersonalSeed {
  return {
    snapshotDate: SNAPSHOT,
    timezone: "America/Los_Angeles",
    companies: [
      {
        name: "Axle",
        nameStatus: "explicit_source",
        domains: ["axleaccess.com"],
        categories: ["candidate", "employer"],
        summary: "Founding AI Engineer opportunity.",
        unresolved: null,
      },
      {
        name: "Abby Care",
        nameStatus: "explicit_source",
        domains: ["withwellspring.com"],
        categories: ["candidate", "employer"],
        summary: "Applied AI Engineer opportunity.",
        unresolved: "Wellspring's relationship to Abby Care is unverified.",
      },
    ],
    contacts: [
      { name: "Chris", email: "chris@axleaccess.com", company: "Axle", title: null, note: null },
      {
        name: "Jacob Alfaro",
        email: "jacob.alfaro@withwellspring.com",
        company: "Abby Care",
        title: "Technical Recruiter",
        note: "Identifies himself as Talent at Abby Care despite the domain.",
      },
    ],
    interactions: [
      {
        company: "Axle",
        contactEmails: ["chris@axleaccess.com"],
        title: "Axle introductory meeting",
        kind: "introduction",
        status: "confirmed",
        startsAt: "2026-10-19T12:30:00",
        endsAt: "2026-10-19T13:00:00",
      },
      {
        company: "Abby Care",
        contactEmails: ["jacob.alfaro@withwellspring.com"],
        title: "Abby Care recruiter screen",
        kind: "recruiter_screen",
        status: "cancelled",
        startsAt: "2026-10-19T13:00:00",
        endsAt: "2026-10-19T13:30:00",
      },
    ],
    opportunities: [
      {
        company: "Axle",
        title: "Founding AI Engineer at Axle",
        stage: "interviewing",
        outcome: "pending",
        primaryContactEmail: "chris@axleaccess.com",
      },
    ],
    ...overrides,
  };
}

suite("personal seed", () => {
  it("writes companies, contacts, an employment edge, and a linked event", async () => {
    const { userId, workspaceId } = await seedWorkspace(db, `seed-basic-${Date.now()}`);
    const auth = ownerAuth(userId, workspaceId);

    const summary = await seedPersonalData(auth, dataset(), { apply: true });
    expect(summary.companies.created).toBe(2);
    expect(summary.contacts.created).toBe(2);
    expect(summary.employments.created).toBe(2);
    expect(summary.events.created).toBe(2);
    expect(summary.opportunities.created).toBe(1);

    const [axle] = await db
      .select({ id: companies.id, domain: companies.domain })
      .from(companies)
      .where(and(eq(companies.workspaceId, workspaceId), eq(companies.name, "Axle")));
    expect(axle.domain).toBe("axleaccess.com");

    const links = await db
      .select({ targetId: eventLinks.targetId })
      .from(eventLinks)
      .where(eq(eventLinks.workspaceId, workspaceId));
    expect(links).toHaveLength(2);
    expect(links.map((link) => link.targetId)).toContain(axle.id);
  });

  it("a re-run adds nothing and keeps the cancelled event cancelled", async () => {
    const { userId, workspaceId } = await seedWorkspace(db, `seed-rerun-${Date.now()}`);
    const auth = ownerAuth(userId, workspaceId);

    await seedPersonalData(auth, dataset(), { apply: true });
    const second = await seedPersonalData(auth, dataset(), { apply: true });

    expect(second.companies.created).toBe(0);
    expect(second.contacts.created).toBe(0);
    expect(second.events.created).toBe(0);
    expect(second.opportunities.created).toBe(0);

    const rows = await db
      .select({ status: events.status, title: events.title })
      .from(events)
      .where(eq(events.workspaceId, workspaceId));
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.title === "Abby Care recruiter screen")?.status).toBe("cancelled");
  });

  it("does not overwrite a description the owner has edited", async () => {
    const { userId, workspaceId } = await seedWorkspace(db, `seed-edit-${Date.now()}`);
    const auth = ownerAuth(userId, workspaceId);

    await seedPersonalData(auth, dataset(), { apply: true });
    await db
      .update(companies)
      .set({ description: "Edited by the owner." })
      .where(and(eq(companies.workspaceId, workspaceId), eq(companies.name, "Axle")));

    await seedPersonalData(auth, dataset(), { apply: true });
    const [axle] = await db
      .select({ description: companies.description })
      .from(companies)
      .where(and(eq(companies.workspaceId, workspaceId), eq(companies.name, "Axle")));
    expect(axle.description).toBe("Edited by the owner.");
  });

  it("does not steal a domain another organization already owns", async () => {
    const { userId, workspaceId } = await seedWorkspace(db, `seed-domain-${Date.now()}`);
    const auth = ownerAuth(userId, workspaceId);
    await db.insert(companies).values({ workspaceId, name: "Incumbent", domain: "axleaccess.com" });

    const summary = await seedPersonalData(auth, dataset(), { apply: true });
    expect(summary.applied).toBe(true);

    const [axle] = await db
      .select({ domain: companies.domain, attributes: companies.attributes })
      .from(companies)
      .where(and(eq(companies.workspaceId, workspaceId), eq(companies.name, "Axle")));
    // The name is kept, the domain is not claimed, and the observation survives
    // as an attribute rather than being silently dropped.
    expect(axle.domain).toBeNull();
    expect(JSON.stringify(axle.attributes)).toContain("axleaccess.com");
  });

  it("dry run writes nothing", async () => {
    const { userId, workspaceId } = await seedWorkspace(db, `seed-dry-${Date.now()}`);
    const auth = ownerAuth(userId, workspaceId);

    const summary = await seedPersonalData(auth, dataset(), { apply: false });
    expect(summary.applied).toBe(false);
    expect(summary.companies.created).toBe(2);

    const rows = await db
      .select({ id: companies.id })
      .from(companies)
      .where(eq(companies.workspaceId, workspaceId));
    expect(rows).toHaveLength(0);
    const people = await db.select({ id: contacts.id }).from(contacts).where(eq(contacts.workspaceId, workspaceId));
    expect(people).toHaveLength(0);
  });

  it("contacts with no email match by name and are never merged by name alone", async () => {
    const { userId, workspaceId } = await seedWorkspace(db, `seed-name-${Date.now()}`);
    const auth = ownerAuth(userId, workspaceId);
    const data = dataset({
      contacts: [
        { name: "Chris", email: null, company: "Axle", title: null, note: null },
        { name: "Chris", email: null, company: "Abby Care", title: null, note: null },
      ],
      interactions: [],
      opportunities: [],
    });

    const summary = await seedPersonalData(auth, data, { apply: true });
    expect(summary.contacts.created).toBe(2);

    const rerun = await seedPersonalData(auth, data, { apply: true });
    expect(rerun.contacts.created).toBe(0);
    expect(rerun.contacts.matched).toBe(2);
  });
});

describe("zonedToUtc", () => {
  it("converts a Pacific wall-clock time across the DST boundary", () => {
    // October 19 is PDT (UTC-7); November 19 is PST (UTC-8).
    expect(zonedToUtc("2026-10-19T12:30:00", "America/Los_Angeles").toISOString()).toBe(
      "2026-10-19T19:30:00.000Z",
    );
    expect(zonedToUtc("2026-11-19T12:30:00", "America/Los_Angeles").toISOString()).toBe(
      "2026-11-19T20:30:00.000Z",
    );
  });
});
