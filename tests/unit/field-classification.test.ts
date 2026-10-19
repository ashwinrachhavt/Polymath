import { describe, expect, it } from "vitest";
import { getTableColumns } from "drizzle-orm";
import { companies, contacts, correspondence } from "@/domains/crm/schema";
import {
  applyFieldPolicy,
  classificationOf,
  FIELD_REGISTRY,
  listClassifiedFields,
  MEMBER_FIELD_POLICY,
  STANDARD_ONLY_POLICY,
} from "@/domains/identity/field-classification";

/*
 * ASH-121 AC07: denied values never enter a payload. These tests pin the
 * removal semantics and - by reading the real Drizzle schemas - that the
 * registry cannot drift onto columns that do not exist.
 */

describe("applyFieldPolicy", () => {
  const record = { id: "c1", full_name: "Ravi Example", primary_email: "ravi@example.com", phone: "+1 555 0100", notes: "met at a conference" };

  it("removes denied values outright and names the removed fields", () => {
    const { record: out, redacted } = applyFieldPolicy("contacts", record, STANDARD_ONLY_POLICY);
    expect(out).toEqual({ id: "c1", full_name: "Ravi Example" });
    expect(redacted.sort()).toEqual(["notes", "phone", "primary_email"]);
    expect(JSON.stringify(out)).not.toContain("ravi@example.com");
  });

  it("the member policy matches today's behavior: everything registered passes", () => {
    const { record: out, redacted } = applyFieldPolicy("contacts", record, MEMBER_FIELD_POLICY);
    expect(out).toEqual(record);
    expect(redacted).toEqual([]);
  });

  it("unregistered columns are standard and always pass", () => {
    expect(classificationOf("contacts", "created_at")).toBe("standard");
    const { record: out } = applyFieldPolicy("contacts", { created_at: "2026-01-01" }, STANDARD_ONLY_POLICY);
    expect(out).toEqual({ created_at: "2026-01-01" });
  });
});

describe("field registry integrity", () => {
  it("names only real columns on real tables", () => {
    const tables: Record<string, unknown> = { contacts, companies, correspondence };
    for (const { table, column } of listClassifiedFields()) {
      const schemaTable = tables[table];
      expect(schemaTable, `registry table ${table}`).toBeDefined();
      const columns = getTableColumns(schemaTable as Parameters<typeof getTableColumns>[0]);
      expect(Object.values(columns).map((c) => c.name), `${table}.${column}`).toContain(column);
    }
  });

  it("marks the free-form identifier bag as restricted", () => {
    expect(FIELD_REGISTRY.companies.attributes).toBe("restricted");
  });
});
