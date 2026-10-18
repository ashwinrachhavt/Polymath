import { describe, expect, it } from "vitest";
import type { AuthContext } from "@/lib/auth";
import {
  assertWorkspaceScope,
  ForbiddenRoleError,
  requireRole,
  type Role,
} from "@/lib/auth/guards";

/*
 * ASH-120 F03 — the pure guards. Resolution itself (deny paths, membership
 * filtering) is owned by identity/resolve.ts and covered by the auth-resolution
 * integration suite that landed with the resolver.
 */

const ctx = (role: Role, workspaceId = "ws-1"): AuthContext => ({
  userId: "u-1",
  workspaceId,
  role,
});

describe("requireRole", () => {
  it("a viewer cannot pass a member check, an owner passes everything", () => {
    // Route handlers map on the machine code, not the message — assert both.
    let caught: unknown;
    try {
      requireRole(ctx("viewer"), "member");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ForbiddenRoleError);
    expect((caught as ForbiddenRoleError).code).toBe("AUTH_FORBIDDEN");
    expect((caught as Error).message).toMatch(/Requires member/);
    expect(() => requireRole(ctx("member"), "member")).not.toThrow();
    expect(() => requireRole(ctx("admin"), "admin")).not.toThrow();
    expect(() => requireRole(ctx("owner"), "viewer")).not.toThrow();
  });

  it("a member cannot pass an admin check", () => {
    expect(() => requireRole(ctx("member"), "admin")).toThrowError(/Requires admin/);
  });

  it("rank is a total order — each role passes its own check", () => {
    for (const role of ["owner", "admin", "member", "viewer"] as const) {
      expect(() => requireRole(ctx(role), role)).not.toThrow();
    }
  });
});

describe("assertWorkspaceScope", () => {
  it("accepts a row from the context's own workspace", () => {
    expect(() => assertWorkspaceScope({ workspaceId: "ws-1" }, ctx("member"))).not.toThrow();
  });

  it("rejects a row from another workspace with the mismatch code", () => {
    let caught: unknown;
    try {
      assertWorkspaceScope({ workspaceId: "ws-2" }, ctx("member"));
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ForbiddenRoleError);
    expect((caught as ForbiddenRoleError).code).toBe("AUTH_WORKSPACE_MISMATCH");
    expect((caught as Error).message).toMatch(/another workspace/);
  });

  it("an owner is not exempt from tenant scope", () => {
    expect(() => assertWorkspaceScope({ workspaceId: "ws-2" }, ctx("owner"))).toThrowError();
  });
});
