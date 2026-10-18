import { describe, expect, it, vi } from "vitest";

// Redaction is pure, but the module also opens the postgres-js pool at import
// time; both handles are mocked so a clean clone without DATABASE_URL runs.
vi.mock("@/lib/db", () => ({ db: {} }));
vi.mock("@/lib/db-transaction", () => ({ withTransaction: vi.fn() }));
import { redact, redactText } from "@/domains/agents/event-bridge";

/*
 * Pure redaction, no database: where a provider credential is masked before it
 * reaches a column. `redact` covers object payloads (tool args/results);
 * `redactText` covers error text, where a credential lands inline in a string
 * ("...failed: api_key=sk-..."). Fails closed on depth instead of walking a
 * cyclic payload forever.
 *
 * The DB-backed redaction (a toolCalls row holds no secret) is asserted in
 * tests/integration/event-bridge.test.ts; this file pins the string and depth
 * behavior that test only exercises indirectly.
 */

describe("redactText", () => {
  it("masks the value after a secret-bearing key", () => {
    expect(redactText("auth failed: api_key=sk-live-abc123")).toBe(
      "auth failed: api_key=[redacted]",
    );
    expect(redactText('{"token":"abc"} send failed')).toBe('{"token":"[redacted]"} send failed');
    expect(redactText("password: hunter2 rejected")).toBe("password: [redacted] rejected");
  });

  it("masks bearer tokens", () => {
    // Both masks fire on "Authorization: Bearer <jwt>" — the key pair and the
    // bearer value. Over-masking is safe; the token never survives.
    expect(redactText("Authorization: Bearer eyJhbGciOi.abc-def")).toBe(
      "Authorization: [redacted] [redacted]",
    );
  });

  it("leaves ordinary text and non-secret values alone", () => {
    expect(redactText("run timed out")).toBe("run timed out");
    expect(redactText("spent $0.42 of $0.50")).toBe("spent $0.42 of $0.50");
  });
});

describe("redact", () => {
  it("masks a matching key at any nest level, keeping siblings visible", () => {
    expect(redact({ to: "x@y.com", nested: { apiKey: "s", keep: "visible" } })).toEqual({
      to: "x@y.com",
      nested: { apiKey: "[redacted]", keep: "visible" },
    });
  });

  it("does not mask a value that merely mentions a key inside other text", () => {
    // Key matching is on key names only; a value like "token" stays a value.
    expect(redact({ note: "token rotated" })).toEqual({ note: "token rotated" });
  });

  it("truncates past the depth cap instead of walking a cyclic payload forever", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;

    // The walk stops at depth 6: levels under the cap render as nested
    // objects, everything past it is "[truncated]". Termination is the
    // contract, not collapsing the outer object.
    expect(redact({ deep: cyclic })).toEqual({
      deep: { self: { self: { self: { self: { self: { self: "[truncated]" } } } } } },
    });
  });

  it("passes primitives through", () => {
    expect(redact("plain")).toBe("plain");
    expect(redact(42)).toBe(42);
    expect(redact(null)).toBe(null);
  });
});
