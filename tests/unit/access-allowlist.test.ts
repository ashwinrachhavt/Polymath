import { beforeEach, describe, expect, it, vi } from "vitest";
import { allowedEmails, hasAllowedEmail, isClerkUserAllowed, resetAllowlistCache } from "@/lib/access-allowlist";

const verified = (emailAddress: string) => ({ emailAddress, verification: { status: "verified" } });
const unverified = (emailAddress: string) => ({ emailAddress, verification: { status: "unverified" } });

describe("allowedEmails", () => {
  it("is unrestricted when unset or blank", () => {
    expect(allowedEmails(undefined)).toBeNull();
    expect(allowedEmails("")).toBeNull();
    expect(allowedEmails(" , ,")).toBeNull();
  });

  it("parses a comma-separated list, trimmed and lowercased", () => {
    expect([...(allowedEmails(" Owner@Example.com, second@example.com ,") ?? [])]).toEqual([
      "owner@example.com",
      "second@example.com",
    ]);
  });
});

describe("hasAllowedEmail", () => {
  const list = new Set(["owner@example.com"]);

  it("matches a verified address regardless of case", () => {
    expect(hasAllowedEmail([verified("OWNER@example.com")], list)).toBe(true);
  });

  it("ignores an unverified address, even one on the list", () => {
    expect(hasAllowedEmail([unverified("owner@example.com")], list)).toBe(false);
  });

  it("rejects an account with no listed address", () => {
    expect(hasAllowedEmail([verified("stranger@example.com")], list)).toBe(false);
  });
});

describe("isClerkUserAllowed", () => {
  const allowed = new Set(["owner@example.com"]);

  beforeEach(() => resetAllowlistCache());

  it("lets everyone in without asking Clerk when no list is configured", async () => {
    const lookup = vi.fn();
    expect(await isClerkUserAllowed("user_a", { allowed: null, lookup })).toBe(true);
    expect(lookup).not.toHaveBeenCalled();
  });

  it("allows a listed user and denies an unlisted one", async () => {
    const lookup = vi.fn(async (id: string) => [verified(id === "user_owner" ? "owner@example.com" : "x@example.com")]);
    expect(await isClerkUserAllowed("user_owner", { allowed, lookup })).toBe(true);
    expect(await isClerkUserAllowed("user_stranger", { allowed, lookup })).toBe(false);
  });

  it("fails closed when Clerk cannot be asked, and asks again next time", async () => {
    const lookup = vi
      .fn()
      .mockRejectedValueOnce(new Error("clerk down"))
      .mockResolvedValue([verified("owner@example.com")]);
    expect(await isClerkUserAllowed("user_owner", { allowed, lookup })).toBe(false);
    expect(await isClerkUserAllowed("user_owner", { allowed, lookup })).toBe(true);
    expect(lookup).toHaveBeenCalledTimes(2);
  });

  it("caches a decision, and a denial expires sooner than an approval", async () => {
    const lookup = vi.fn(async () => [verified("x@example.com")]);
    await isClerkUserAllowed("user_stranger", { allowed, lookup, now: 0 });
    await isClerkUserAllowed("user_stranger", { allowed, lookup, now: 30_000 });
    expect(lookup).toHaveBeenCalledTimes(1);
    await isClerkUserAllowed("user_stranger", { allowed, lookup, now: 61_000 });
    expect(lookup).toHaveBeenCalledTimes(2);
  });
});
