import { beforeEach, describe, expect, it, vi } from "vitest";
import { UnauthorizedError } from "@/lib/auth";

/*
 * Server-action error hygiene for the Settings API keys panel: a database
 * failure (e.g. prod missing a column a pending migration adds) must surface
 * as the action's generic message, never the driver's raw "Failed query"
 * dump with its SQL and parameters. Auth rejections are hand-written safe
 * strings and pass through unchanged.
 */

const machine = vi.hoisted(() => ({
  listApiClients: vi.fn(),
  createApiClient: vi.fn(),
  revokeApiClient: vi.fn(),
}));
vi.mock("@/domains/identity/machine", () => machine);

const getAuthContext = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/auth")>();
  return { ...original, getAuthContext };
});

import { createApiKeyAction, listApiKeysAction, revokeApiKeyAction } from "@/app/(workspace)/settings/api-key-actions";

const ownerAuth = { userId: "u", workspaceId: "w", role: "owner" as const };

// What a missing-column failure looks like from the driver (kql/pg shape):
// the full statement and its bound parameters.
const RAW_DB_ERROR = new Error(
  'Failed query: select "id", "workspace_id", "key_id" from "api_clients" where ("api_clients"."workspace_id" = $1) params: f4327824-9579-4245-9f04-6fcc7bb673c6',
);

beforeEach(() => {
  vi.clearAllMocks();
  getAuthContext.mockResolvedValue(ownerAuth);
});

describe("listApiKeysAction", () => {
  it("answers a driver error with the generic message, no SQL or params", async () => {
    machine.listApiClients.mockRejectedValue(RAW_DB_ERROR);
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const result = await listApiKeysAction();

    expect(result).toEqual({ ok: false, error: "Could not load API keys." });
    expect(JSON.stringify(result)).not.toContain("api_clients");
    expect(JSON.stringify(result)).not.toContain("Failed query");
    expect(JSON.stringify(result)).not.toContain("f4327824");
    // The log is metadata-only: label, error class, SQLSTATE - never the
    // raw message, SQL, or bindings (pinned in action-error.test.ts).
    expect(spy.mock.calls[0]).toEqual(["[action]", "Could not load API keys.", { name: "Error" }]);
    spy.mockRestore();
  });

  it("maps a healthy listing to DTOs with ISO dates", async () => {
    machine.listApiClients.mockResolvedValue([
      {
        id: "c1",
        name: "companion",
        kind: "companion",
        keyId: "abc123",
        scopes: ["captures:read"],
        status: "active",
        pairedAt: new Date("2026-10-01T12:00:00Z"),
        lastSeenAt: null,
        expiresAt: null,
      },
    ]);

    const result = await listApiKeysAction();

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.keys).toHaveLength(1);
      expect(result.keys[0].pairedAt).toBe("2026-10-01T12:00:00.000Z");
      expect(result.keys[0].lastSeenAt).toBeNull();
    }
  });

  it("passes the authored auth message through instead of the generic one", async () => {
    getAuthContext.mockRejectedValue(new UnauthorizedError());

    const result = await listApiKeysAction();

    expect(result).toEqual({ ok: false, error: "No signed-in session." });
  });
});

describe("createApiKeyAction", () => {
  it("sanitizes a driver error", async () => {
    machine.createApiClient.mockRejectedValue(RAW_DB_ERROR);
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const result = await createApiKeyAction({ name: "x", kind: "companion", scopes: [] });

    expect(result).toEqual({ ok: false, error: "Could not create the key." });
    expect(JSON.stringify(result)).not.toContain("Failed query");
  });
});

describe("revokeApiKeyAction", () => {
  it("sanitizes a driver error", async () => {
    machine.revokeApiClient.mockRejectedValue(RAW_DB_ERROR);
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const result = await revokeApiKeyAction({ clientId: "c1" });

    expect(result).toEqual({ ok: false, error: "Could not revoke the key." });
    expect(JSON.stringify(result)).not.toContain("Failed query");
  });
});
