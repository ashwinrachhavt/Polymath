import { describe, expect, it } from "vitest";
import {
  COMPANY_CARD_KINDS,
  CONTACT_CARD_KINDS,
  ProfileResearchError,
  ProfileResearchUnusableAnswerError,
  groundCards,
  normalizeDomain,
  planCompanyEvidence,
  planContactEvidence,
  parseProfileResearchAnswer,
} from "@/domains/knowledge/profile-research";

/*
 * ASH-291: the research contract's guarantees are deterministic - the
 * evidence plan, the bounded budgets, the strict parse and the citation
 * check are code, not prompt instructions. The model never decides them.
 */

describe("normalizeDomain", () => {
  it("strips protocol, path and www", () => {
    expect(normalizeDomain("https://www.Example.com/about")).toBe("example.com");
    expect(normalizeDomain("acme.io")).toBe("acme.io");
  });

  it("passes null through and rejects junk instead of crawling it", () => {
    expect(normalizeDomain(null)).toBeNull();
    expect(() => normalizeDomain("not a domain")).toThrow(ProfileResearchError);
    expect(() => normalizeDomain("localhost")).toThrow(ProfileResearchError);
  });
});

describe("planCompanyEvidence", () => {
  it("crawls homepage and about page, then one bounded news search", () => {
    const steps = planCompanyEvidence({ name: "Acme", domain: "acme.com" });
    expect(steps).toEqual([
      { kind: "fetch", url: "https://acme.com/", purpose: "homepage" },
      { kind: "fetch", url: "https://acme.com/about", purpose: "about page" },
      { kind: "search", query: '"Acme" news', purpose: "recent news" },
    ]);
  });

  it("plans zero fetches without a domain - search-only is structural", () => {
    const steps = planCompanyEvidence({ name: "Acme", domain: null });
    expect(steps.every((s) => s.kind === "search")).toBe(true);
    expect(steps).toHaveLength(1);
  });

  it("requires a name and does not let quotes break the query", () => {
    expect(() => planCompanyEvidence({ name: " ", domain: null })).toThrow(ProfileResearchError);
    const steps = planCompanyEvidence({ name: 'Acme "Inc"', domain: null });
    expect(steps[0]).toMatchObject({ kind: "search", query: "\"Acme 'Inc'\" news" });
  });
});

describe("planContactEvidence", () => {
  it("pairs identity with the requested focus", () => {
    const steps = planContactEvidence({ fullName: "Priya Nair", currentCompanyName: "Acme", focus: "background" });
    expect(steps).toHaveLength(2);
    expect(steps[0]).toEqual({ kind: "search", query: '"Priya Nair" "Acme"', purpose: "identity" });
    expect(steps[1]).toMatchObject({ purpose: "background" });
    expect(steps[1]).toMatchObject({ query: expect.stringContaining("bio OR background OR career") });
  });

  it("shapes mentions and talking-points queries around the person", () => {
    const mentions = planContactEvidence({ fullName: "Priya Nair", currentCompanyName: null, focus: "mentions" });
    expect(mentions[1]).toMatchObject({ query: '"Priya Nair" news OR interview OR talk' });
    const points = planContactEvidence({ fullName: "Priya Nair", currentCompanyName: null, focus: "talking-points" });
    expect(points[1]).toMatchObject({ query: expect.stringContaining("writing OR podcast OR interests") });
  });

  it("defaults the full profile to identity plus recent mentions", () => {
    const steps = planContactEvidence({ fullName: "Priya Nair", currentCompanyName: null, focus: "profile" });
    expect(steps[1]).toMatchObject({ purpose: "recent mentions" });
  });

  it("requires a name", () => {
    expect(() => planContactEvidence({ fullName: "", currentCompanyName: null, focus: "profile" })).toThrow(ProfileResearchError);
  });
});

describe("parseProfileResearchAnswer", () => {
  it("accepts a company card set", () => {
    const cards = parseProfileResearchAnswer(
      JSON.stringify({ cards: [{ kind: "overview", title: "What Acme does", body: "Acme sells anvils.", citations: [1, 2] }] }),
      COMPANY_CARD_KINDS,
    );
    expect(cards).toHaveLength(1);
    expect(cards[0].kind).toBe("overview");
  });

  it("rejects a contact card kind on a company pass and vice versa", () => {
    const answer = JSON.stringify({ cards: [{ kind: "background", title: "t", body: "b", citations: [1] }] });
    expect(() => parseProfileResearchAnswer(answer, COMPANY_CARD_KINDS)).toThrow(ProfileResearchUnusableAnswerError);
    expect(() => parseProfileResearchAnswer(answer, CONTACT_CARD_KINDS)).not.toThrow();
  });

  it("rejects non-JSON and cards without any citation", () => {
    expect(() => parseProfileResearchAnswer("here are some cards", COMPANY_CARD_KINDS)).toThrowError(/not JSON/);
    const uncited = JSON.stringify({ cards: [{ kind: "news", title: "t", body: "b", citations: [] }] });
    expect(() => parseProfileResearchAnswer(uncited, COMPANY_CARD_KINDS)).toThrowError(/did not match/);
  });

  it("rejects over-cap card sets instead of truncating them", () => {
    const cards = Array.from({ length: 7 }, (_, i) => ({ kind: "news", title: `t${i}`, body: "b", citations: [1] }));
    expect(() => parseProfileResearchAnswer(JSON.stringify({ cards }), COMPANY_CARD_KINDS)).toThrowError(/did not match/);
  });
});

describe("groundCards", () => {
  it("keeps cards whose citations resolve, with duplicates and out-of-range refs stripped", () => {
    const { grounded, gaps } = groundCards([{ kind: "news", title: "t", body: "b", citations: [2, 2, 9, 1] }], 3);
    expect(gaps).toBe(0);
    expect(grounded[0].citations).toEqual([2, 1]);
  });

  it("drops a card no citation supports and records the gap", () => {
    const { grounded, gaps } = groundCards(
      [
        { kind: "news", title: "grounded", body: "b", citations: [1] },
        { kind: "watch", title: "invented", body: "b", citations: [7] },
      ],
      3,
    );
    expect(grounded.map((c) => c.title)).toEqual(["grounded"]);
    expect(gaps).toBe(1);
  });

  it("with an empty manifest every card is a gap - nothing is smoothed over", () => {
    const { grounded, gaps } = groundCards([{ kind: "news", title: "t", body: "b", citations: [1] }], 0);
    expect(grounded).toHaveLength(0);
    expect(gaps).toBe(1);
  });
});
