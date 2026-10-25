import { describe, expect, it } from "vitest";
import { checkSenderAlias, parseSenderAliasPolicy } from "@/domains/actions/policy";

/*
 * ASH-289: a sending grant scopes to explicitly authorized aliases. The key
 * being ABSENT keeps the pre-grant behavior (unrestricted); a PRESENT list
 * is the owner's deliberate choice - including the empty list that blocks
 * every sender. Clearing all checks must narrow to nothing, never widen a
 * tightened grant back to unrestricted, or an unlisted account could
 * substitute as sender.
 */

describe("parseSenderAliasPolicy", () => {
  it("reads a non-empty list, deduped", () => {
    expect(parseSenderAliasPolicy({ allowedSenderAliases: ["work", "work", "founder"] })).toEqual({
      configured: true,
      aliases: ["work", "founder"],
    });
  });

  it("treats a missing key and unreadable bags as unconfigured", () => {
    expect(parseSenderAliasPolicy(undefined)).toEqual({ configured: false });
    expect(parseSenderAliasPolicy({})).toEqual({ configured: false });
    expect(parseSenderAliasPolicy("not an object")).toEqual({ configured: false });
    expect(parseSenderAliasPolicy({ allowedSenderAliases: ["", "   "] })).toEqual({ configured: false });
  });

  it("treats an explicitly empty list as configured: every sender blocked", () => {
    expect(parseSenderAliasPolicy({ allowedSenderAliases: [] })).toEqual({ configured: true, aliases: [] });
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

  it("lets an unnamed sender through to restricted resolution - substitution is prevented there", () => {
    // The check refuses only a NAMED unauthorized alias. An unnamed sender is
    // resolved inside the authorized list only, which is where substitution
    // of an unlisted connected account is prevented.
    expect(checkSenderAlias(policy, null)).toEqual({ allowed: true });
  });

  it("refuses every named sender when the grant was saved empty", () => {
    const empty = { configured: true as const, aliases: [] };
    const verdict = checkSenderAlias(empty, "work");
    expect(verdict.allowed).toBe(false);
    if (!verdict.allowed) expect(verdict.reason).toContain("No sender is authorized");
    // An unnamed proposal still passes to resolution, which fails honestly:
    // no account resolves inside an empty list.
    expect(checkSenderAlias(empty, null)).toEqual({ allowed: true });
  });
});
