import { describe, expect, it } from "vitest";
import { checkSenderAlias, parseSenderAliasPolicy } from "@/domains/actions/policy";

/*
 * ASH-289: a sending grant scopes to explicitly authorized aliases. The
 * parser treats a missing or empty list as UNCONFIGURED (the pre-grant
 * behavior), never as "no sender may send" - nobody writes an empty list to
 * mean that, and the harsher reading would silently brick every send.
 */

describe("parseSenderAliasPolicy", () => {
  it("reads a non-empty list, deduped", () => {
    expect(parseSenderAliasPolicy({ allowedSenderAliases: ["work", "work", "founder"] })).toEqual({
      configured: true,
      aliases: ["work", "founder"],
    });
  });

  it("treats missing, empty, junk and blank-only lists as unconfigured", () => {
    expect(parseSenderAliasPolicy(undefined)).toEqual({ configured: false });
    expect(parseSenderAliasPolicy({})).toEqual({ configured: false });
    expect(parseSenderAliasPolicy({ allowedSenderAliases: [] })).toEqual({ configured: false });
    expect(parseSenderAliasPolicy("not an object")).toEqual({ configured: false });
    expect(parseSenderAliasPolicy({ allowedSenderAliases: ["", "   "] })).toEqual({ configured: false });
  });
});

describe("checkSenderAlias", () => {
  const policy = { configured: true as const, aliases: ["work"] };

  it("allows anything when unconfigured", () => {
    expect(checkSenderAlias({ configured: false }, null)).toEqual({ allowed: true });
    expect(checkSenderAlias({ configured: false }, "personal")).toEqual({ allowed: true });
  });

  it("allows only listed aliases when configured", () => {
    expect(checkSenderAlias(policy, "work")).toEqual({ allowed: true });
    const verdict = checkSenderAlias(policy, "personal");
    expect(verdict.allowed).toBe(false);
    if (!verdict.allowed) expect(verdict.reason).toContain('"personal" is not an authorized sender');
  });

  it("never substitutes for an unnamed sender", () => {
    const verdict = checkSenderAlias(policy, null);
    expect(verdict.allowed).toBe(false);
    if (!verdict.allowed) expect(verdict.reason).toContain("No account was substituted");
  });
});
