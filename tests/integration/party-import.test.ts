import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { contactPoints, organizations, partyEmployment, people } from "@/domains/identity/schema";
import { makeTestDb, ownerAuth, seedWorkspace } from "../helpers/test-workspace";

/*
 * The import invariants that only real Postgres can hold: email is the merge
 * key, a re-run adds nothing, two different people at one company share the
 * organization rather than duplicating it, and a domain already owned by
 * another org does not throw mid-file. Skipped without a scratch database,
 * same as the other integration suites.
 */

const handle = makeTestDb();
const suite = handle ? describe : describe.skip;
let db: NonNullable<typeof handle>["db"];
let importConnections: typeof import("@/domains/identity/party-csv").importConnections;

beforeAll(async () => {
  if (!handle) return;
  ({ db } = handle);
  ({ importConnections } = await import("@/domains/identity/party-csv"));
});

afterAll(async () => {
  await handle?.client.end();
});

const HEADER = "First Name,Last Name,URL,Email Address,Company,Position,Connected On\n";

suite("connections import", () => {
  it("creates people and orgs, then a re-run adds nothing", async () => {
    const { userId, workspaceId } = await seedWorkspace(db, `imp-rerun-${Date.now()}`);
    const a = ownerAuth(userId, workspaceId);
    const csv =
      HEADER +
      "Ada,Lovelace,,ada@calc.dev,Analytical Engines,Engineer,01 Jan 2026\n" +
      "Grace,Hopper,,grace@navy.mil,Analytical Engines,Engineer,01 Jan 2026\n";

    const first = await importConnections(a, { csv });
    expect(first.peopleCreated).toBe(2);
    expect(first.organizationsCreated).toBe(1);

    const second = await importConnections(a, { csv });
    expect(second.peopleCreated).toBe(0);
    expect(second.peopleMatched).toBe(2);
    expect(second.organizationsCreated).toBe(0);

    // The edges are the evidence that a re-run wrote nothing new: two people
    // at one company, still two rows after the second import.
    const edges = await db
      .select({ id: partyEmployment.id })
      .from(partyEmployment)
      .where(eq(partyEmployment.workspaceId, workspaceId));
    expect(edges).toHaveLength(2);

    const orgs = await db
      .select({ id: organizations.id })
      .from(organizations)
      .where(eq(organizations.workspaceId, workspaceId));
    expect(orgs).toHaveLength(1);

    const persons = await db
      .select({ id: people.id })
      .from(people)
      .where(eq(people.workspaceId, workspaceId));
    expect(persons).toHaveLength(2);
  });

  it("same email in two rows is one person, even with different names", async () => {
    const { userId, workspaceId } = await seedWorkspace(db, `imp-email-${Date.now()}`);
    const a = ownerAuth(userId, workspaceId);
    const csv =
      HEADER +
      "Ada,Lovelace,,ada@calc.dev,Analytical Engines,Engineer,01 Jan 2026\n" +
      "A.,Lovelace,,ADA@Calc.dev,Bletchley Park,Analyst,01 Jan 2026\n";

    const summary = await importConnections(a, { csv });
    expect(summary.peopleCreated).toBe(1);
    expect(summary.peopleMatched).toBe(1);

    const points = await db
      .select({ value: contactPoints.value })
      .from(contactPoints)
      .where(
        and(
          eq(contactPoints.workspaceId, workspaceId),
          eq(contactPoints.kind, "email"),
        ),
      );
    expect(points).toHaveLength(1);
    expect(points[0].value).toBe("ada@calc.dev");

    // Two orgs, because the second row's company differs from the first: the
    // person accumulates employment edges rather than one winning column.
    const edges = await db
      .select({ id: partyEmployment.id })
      .from(partyEmployment)
      .where(eq(partyEmployment.workspaceId, workspaceId));
    expect(edges).toHaveLength(2);
  });

  it("a name with no email is never merged into an existing person", async () => {
    const { userId, workspaceId } = await seedWorkspace(db, `imp-name-${Date.now()}`);
    const a = ownerAuth(userId, workspaceId);
    const csv =
      HEADER +
      "Ada,Lovelace,,ada@calc.dev,Analytical Engines,Engineer,01 Jan 2026\n" +
      "Ada,Lovelace,,,Analytical Engines,Engineer,01 Jan 2026\n";

    const summary = await importConnections(a, { csv });
    // Two rows, two people: identical name and company are not identity.
    expect(summary.peopleCreated).toBe(2);
    expect(summary.peopleMatched).toBe(0);
  });

  it("a malformed email skips its row and reports the line", async () => {
    const { userId, workspaceId } = await seedWorkspace(db, `imp-bad-${Date.now()}`);
    const a = ownerAuth(userId, workspaceId);
    const csv =
      HEADER +
      "Ada,Lovelace,,not-an-email,Analytical Engines,Engineer,01 Jan 2026\n" +
      "Grace,Hopper,,grace@navy.mil,,,01 Jan 2026\n";

    const summary = await importConnections(a, { csv });
    expect(summary.skipped).toBe(1);
    expect(summary.problems[0]).toMatchObject({ line: 2 });
    expect(summary.peopleCreated).toBe(1);
  });

  it("a domain owned by another org does not abort the file", async () => {
    const { userId, workspaceId } = await seedWorkspace(db, `imp-domain-${Date.now()}`);
    const a = ownerAuth(userId, workspaceId);
    await db
      .insert(organizations)
      .values({ workspaceId, name: "Owner Of calc.dev", domain: "calc.dev" });

    const csv = HEADER + "Ada,Lovelace,,ada@calc.dev,Analytical Engines,Engineer,01 Jan 2026\n";
    const summary = await importConnections(a, { csv });

    expect(summary.organizationsCreated).toBe(1);
    const created = await db
      .select({ name: organizations.name, domain: organizations.domain })
      .from(organizations)
      .where(and(eq(organizations.workspaceId, workspaceId), eq(organizations.name, "Analytical Engines")));
    // The second org keeps its name but does not steal the domain.
    expect(created[0]).toMatchObject({ name: "Analytical Engines", domain: null });
  });

  it("refuses a file over the row limit before writing anything", async () => {
    const { userId, workspaceId } = await seedWorkspace(db, `imp-limit-${Date.now()}`);
    const a = ownerAuth(userId, workspaceId);
    const csvRows = Array.from({ length: 5001 }, (_, i) => `P${i},Q,,,X,,01 Jan 2026`).join("\n");
    await expect(importConnections(a, { csv: HEADER + csvRows + "\n" })).rejects.toThrow(
      /import limit/,
    );

    const written = await db
      .select({ id: people.id })
      .from(people)
      .where(eq(people.workspaceId, workspaceId));
    expect(written).toHaveLength(0);
  });
});
