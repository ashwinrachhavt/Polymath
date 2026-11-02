import { describe, expect, it } from "vitest";
// The extension ships plain scripts; the rule engine is exported for Node.
import Focus from "../../extensions/chrome/focus-core.js";

function entry(pattern: string, kind: "block" | "allow" = "block", id = pattern) {
  return { id, pattern, kind };
}

describe("focus blocklist pattern normalization", () => {
  it("keeps a bare hostname", () => {
    expect(Focus.normalizePattern("news.ycombinator.com")).toBe("news.ycombinator.com");
  });

  it("folds case and whitespace — the table stores lowercased hostnames", () => {
    expect(Focus.normalizePattern("  GitHub.com ")).toBe("github.com");
  });

  it("tolerates a pasted URL, glob, port, and trailing dot", () => {
    expect(Focus.normalizePattern("https://x.com/notes")).toBe("x.com");
    expect(Focus.normalizePattern("http://mail.google.com/u/0?pli=1#inbox")).toBe("mail.google.com");
    expect(Focus.normalizePattern("*.example.com")).toBe("example.com");
    expect(Focus.normalizePattern("example.com:8080")).toBe("example.com");
    expect(Focus.normalizePattern("example.com.")).toBe("example.com");
  });

  it("rejects what cannot name a host", () => {
    expect(Focus.normalizePattern("")).toBeNull();
    expect(Focus.normalizePattern("   ")).toBeNull();
    expect(Focus.normalizePattern("not a host!")).toBeNull();
    expect(Focus.normalizePattern("no-dots")).toBeNull();
    expect(Focus.normalizePattern("-bad-.com")).toBeNull();
    expect(Focus.normalizePattern(null as unknown as string)).toBeNull();
  });

  it("allows localhost as the one useful single-label host", () => {
    expect(Focus.normalizePattern("localhost")).toBe("localhost");
  });
});

describe("focus blocklist → DNR rule conversion", () => {
  it("puts allows above blocks — a matching allow wins over any matching block", () => {
    const { rules } = Focus.toDnrRules([entry("x.com"), entry("mail.x.com", "allow")]);
    const allow = rules.find((r: { action: { type: string } }) => r.action.type === "allow");
    const block = rules.find((r: { action: { type: string } }) => r.action.type === "redirect");
    expect(allow && block).toBeTruthy();
    if (!allow || !block) return; // the expect above already failed
    expect(allow.priority).toBeGreaterThan(block.priority);
    expect(allow.condition.requestDomains).toEqual(["mail.x.com"]);
    expect(block.condition.requestDomains).toEqual(["x.com"]);
  });

  it("emits allow rules first, in their own id band", () => {
    const { rules } = Focus.toDnrRules([entry("b.com"), entry("a.com", "allow")]);
    expect(rules[0].id).toBe(Focus.ALLOW_RULE_ID_BASE);
    expect(rules[1].id).toBe(Focus.BLOCK_RULE_ID_BASE);
  });

  it("redirects blocked main-frame navigations to the ghost interstitial", () => {
    const { rules } = Focus.toDnrRules([entry("distraction.example")]);
    expect(rules[0].action).toEqual({
      type: "redirect",
      redirect: { extensionPath: "/focus-block.html" },
    });
    expect(rules[0].condition.resourceTypes).toEqual(["main_frame"]);
  });

  it("dedupes domains after normalization — first occurrence wins, matching the API's precedence order", () => {
    const allowFirst = Focus.toDnrRules([entry("a.com", "allow"), entry("a.com")]);
    const blockFirst = Focus.toDnrRules([entry("a.com"), entry("a.com", "allow")]);
    expect(allowFirst.rules).toHaveLength(1);
    expect(allowFirst.rules[0].action.type).toBe("allow");
    expect(blockFirst.rules).toHaveLength(1);
    expect(blockFirst.rules[0].action.type).toBe("redirect");
  });

  it("reports unusable patterns instead of dropping them silently", () => {
    const { rules, skipped } = Focus.toDnrRules([entry("ok.com"), entry("not a host!"), entry("ok.com", "allow")]);
    expect(rules).toHaveLength(1);
    expect(skipped).toEqual(["not a host!", "ok.com"]);
  });

  it("caps conversion at the dynamic rule budget", () => {
    const entries: Array<{ id: string; pattern: string; kind: "block" | "allow" }> = [];
    for (let i = 0; i < Focus.MAX_RULES + 25; i++) entries.push(entry(`site-${i}.example.com`));
    const { rules, truncated } = Focus.toDnrRules(entries);
    expect(rules).toHaveLength(Focus.MAX_RULES);
    expect(truncated).toBe(true);
  });

  it("treats a non-array as an empty blocklist", () => {
    expect(Focus.toDnrRules(null as unknown as unknown[]).rules).toEqual([]);
  });
});

describe("focus rule id ownership", () => {
  it("claims only the band this module installs", () => {
    expect(Focus.ownsRuleId(Focus.ALLOW_RULE_ID_BASE)).toBe(true);
    expect(Focus.ownsRuleId(Focus.BLOCK_RULE_ID_BASE)).toBe(true);
    expect(Focus.ownsRuleId(Focus.RULE_ID_BAND_END)).toBe(false);
    expect(Focus.ownsRuleId(1)).toBe(false);
    expect(Focus.ownsRuleId(999_999)).toBe(false);
  });
});
