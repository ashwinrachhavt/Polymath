import { describe, expect, it, vi } from "vitest";
import { actionError } from "@/lib/action-error";
import { ForbiddenError, UnauthorizedError } from "@/lib/auth";
import { ForbiddenRoleError } from "@/lib/auth/guards";

/*
 * The log side of the boundary is metadata-only. Raw messages are pinned
 * out across the shapes a driver failure actually takes - inline literals,
 * driver-specific binding formats, nested causes - because no rewrite of
 * the message can be a reliable secret boundary.
 */

function loggedArgs(error: unknown): unknown[] {
  const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
  actionError(error, "Could not load API keys.");
  const args = spy.mock.calls[0];
  spy.mockRestore();
  return args;
}

describe("actionError logging", () => {
  it("never logs an inline literal from the message", () => {
    const error = new Error(
      'duplicate key value violates unique constraint "users_clerk_user_id_unique": Key (clerk_user_id)=(tw_secret_live) already exists.',
    );
    const args = loggedArgs(error);
    expect(args[0]).toBe("[action]");
    expect(args[1]).toBe("Could not load API keys.");
    expect(args[2]).toEqual({ name: "Error" });
    expect(JSON.stringify(args)).not.toContain("tw_secret_live");
    expect(JSON.stringify(args)).not.toContain("duplicate key");
  });

  it("keeps a standard SQLSTATE code, never the driver binding fields", () => {
    const error = Object.assign(new Error("column api_clients.key_id does not exist"), {
      name: "PostgresError",
      code: "42703",
      parameters: ["f4327824-9579-4245-9f04-6fcc7bb673c6", "axm_deadbeef"],
      query: 'select "key_id" from "api_clients"',
    });
    const args = loggedArgs(error);
    expect(args[2]).toEqual({ name: "PostgresError", code: "42703" });
    expect(JSON.stringify(args)).not.toContain("f4327824");
    expect(JSON.stringify(args)).not.toContain("axm_deadbeef");
    expect(JSON.stringify(args)).not.toContain("api_clients");
  });

  it("never logs a nested cause's message, only its SQLSTATE code", () => {
    const error = Object.assign(new Error("Failed query: select ..."), {
      name: "Error",
      cause: Object.assign(new Error("column key_id does not exist; token_hash=deadbeefsecret"), {
        name: "PostgresError",
        code: "42703",
      }),
    });
    const args = loggedArgs(error);
    expect(args[2]).toEqual({ name: "Error", code: "42703" });
    expect(JSON.stringify(args)).not.toContain("deadbeefsecret");
    expect(JSON.stringify(args)).not.toContain("key_id");
  });

  it("rejects a code that is not SQLSTATE-shaped", () => {
    const error = Object.assign(new Error("boom"), { code: "credential-xyz" });
    expect(loggedArgs(error)[2]).toEqual({ name: "Error" });
  });

  it("handles non-Error throws", () => {
    expect(loggedArgs("plain string")[2]).toEqual({ name: "string" });
  });
});

describe("actionError client result", () => {
  it("maps recognized auth codes to fixed authored copy, never the thrown message", () => {
    expect(actionError(new UnauthorizedError(), "x")).toBe("No signed-in session.");
    expect(actionError(new ForbiddenError("no workspace membership"), "x")).toBe(
      "This membership does not grant that.",
    );
    expect(
      actionError(new ForbiddenRoleError("AUTH_WORKSPACE_MISMATCH", "Record belongs to another workspace."), "x"),
    ).toBe("Record belongs to another workspace.");
    // Even a forged mismatch message gets the authored copy, not the thrown text.
    expect(actionError(new ForbiddenRoleError("AUTH_WORKSPACE_MISMATCH", "workspace w-123 has no rows"), "x")).toBe(
      "Record belongs to another workspace.",
    );
  });

  it("passes a guard-authored AUTH_FORBIDDEN message only when it matches the template exactly", () => {
    expect(actionError(new ForbiddenRoleError("AUTH_FORBIDDEN", "Requires owner; this member is viewer."), "x")).toBe(
      "Requires owner; this member is viewer.",
    );
    expect(
      actionError(new ForbiddenRoleError("AUTH_FORBIDDEN", "This API key does not carry the captures:read scope."), "x"),
    ).toBe("This API key does not carry the captures:read scope.");
  });

  it("a forged AUTH_FORBIDDEN message outside the templates gets the fixed copy", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const forged = new ForbiddenRoleError("AUTH_FORBIDDEN", 'Requires owner; this member is viewer". DROP TABLE --');
    expect(actionError(forged, "x")).toBe("You don't have permission to do that.");
    const forgedScope = new ForbiddenRoleError("AUTH_FORBIDDEN", 'This API key does not carry the x" OR 1=1 -- scope.');
    expect(actionError(forgedScope, "x")).toBe("You don't have permission to do that.");
  });

  it("a forged recognized-code error cannot inject its message or reach the log", () => {
    const forged = Object.assign(
      new Error('Failed query: select "token_hash" from "api_clients" params: axm_deadbeef'),
      { code: "forbidden", name: "PostgresError" },
    );
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const result = actionError(forged, "Could not load API keys.");
    expect(result).toBe("This membership does not grant that.");
    expect(result).not.toContain("token_hash");
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("an unrecognized error name collapses to the generic metadata name", () => {
    const forged = Object.assign(new Error("boom"), { name: "Evil<script>Error" });
    expect(loggedArgs(forged)[2]).toEqual({ name: "Error" });
  });

  it("answers anything else with the fallback", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(actionError(new Error("secret"), "Could not load API keys.")).toBe("Could not load API keys.");
  });
});
