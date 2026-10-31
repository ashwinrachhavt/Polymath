import { describe, expect, it } from "vitest";
import { isUniqueViolation } from "@/lib/pg-errors";

/*
 * "Duplicate means replay the winner" is only as good as the detection: the
 * same server error arrives bare (postgres-js surface), wrapped one level
 * (drizzle's DrizzleQueryError keeps the original in `cause`), and with an
 * optional constraint name. Every layout below is one a site has actually hit
 * in production code - a predicate that misses one turns a legitimate replay
 * into an unhandled 500.
 */

describe("isUniqueViolation", () => {
  it("matches the unwrapped postgres-js shape (code at top level)", () => {
    expect(isUniqueViolation({ code: "23505" })).toBe(true);
  });

  it("matches the drizzle-wrapped shape (code under cause)", () => {
    expect(isUniqueViolation({ query: "insert", params: [], cause: { code: "23505" } })).toBe(true);
  });

  it("matches deeper cause nesting", () => {
    expect(isUniqueViolation({ cause: { cause: { code: "23505" } } })).toBe(true);
  });

  it("rejects other pg errors and junk", () => {
    expect(isUniqueViolation({ code: "23503" })).toBe(false);
    expect(isUniqueViolation({ code: "40001" })).toBe(false);
    expect(isUniqueViolation(new Error("ordinary throw"))).toBe(false);
    expect(isUniqueViolation(null)).toBe(false);
    expect(isUniqueViolation(undefined)).toBe(false);
    expect(isUniqueViolation("23505")).toBe(false);
  });

  it("with a constraint: matches the named constraint at either level", () => {
    const top = { code: "23505", constraint_name: "documents_workspace_source_url_key" };
    const wrapped = { cause: { code: "23505", constraint_name: "documents_workspace_source_url_key" } };
    expect(isUniqueViolation(top, "documents_workspace_source_url_key")).toBe(true);
    expect(isUniqueViolation(wrapped, "documents_workspace_source_url_key")).toBe(true);
  });

  it("with a constraint: rejects a different constraint at any level", () => {
    expect(
      isUniqueViolation({ code: "23505", constraint_name: "some_other_key" }, "documents_workspace_source_url_key"),
    ).toBe(false);
    expect(
      isUniqueViolation({ cause: { code: "23505", constraint_name: "some_other_key" } }, "documents_workspace_source_url_key"),
    ).toBe(false);
  });

  it("with a constraint: an unnamed violation counts (wrappers may not forward the name)", () => {
    expect(isUniqueViolation({ code: "23505" }, "documents_workspace_source_url_key")).toBe(true);
    expect(isUniqueViolation({ cause: { code: "23505" } }, "documents_workspace_source_url_key")).toBe(true);
  });

  it("keeps walking when a wrapper strips the constraint name", () => {
    // A wrapped 23505 for a different constraint must not match, but the walk
    // continues: a nested violation for the right one still does.
    const nested = {
      code: "23505",
      constraint_name: "some_other_key",
      cause: { code: "23505", constraint_name: "documents_workspace_source_url_key" },
    };
    expect(isUniqueViolation(nested, "documents_workspace_source_url_key")).toBe(true);
  });
});
