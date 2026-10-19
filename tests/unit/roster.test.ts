import { describe, expect, it } from "vitest";
import {
  SPECIALIST_ROSTER,
  SPECIALIST_TEAMS,
  specialistBySlug,
  specialistProfileName,
  specialistSlugFromProfileName,
} from "@/domains/agents/roster";

/*
 * Roster integrity: the catalog is the source of truth for what can be
 * installed, so a broken entry (duplicate slug, unknown team, unknown
 * capability) is a test failure, not a runtime surprise in the bench UI.
 */

const KNOWN_CAPABILITIES = new Set(["tasks.read", "documents.search", "web.search", "web.fetch", "gmail.send"]);

describe("specialist roster", () => {
  it("covers the seven teams from the owner's reference tree", () => {
    expect([...SPECIALIST_TEAMS]).toEqual([
      "engineering",
      "product",
      "marketing",
      "design",
      "project-management",
      "studio-operations",
      "testing",
    ]);
    for (const team of SPECIALIST_TEAMS) {
      expect(SPECIALIST_ROSTER.some((s) => s.team === team)).toBe(true);
    }
  });

  it("has unique slugs", () => {
    const slugs = SPECIALIST_ROSTER.map((s) => s.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it("every role has a mission, a brief, and known capabilities only", () => {
    for (const specialist of SPECIALIST_ROSTER) {
      expect(specialist.mission.length).toBeGreaterThan(0);
      expect(specialist.instructions.length).toBeGreaterThan(0);
      expect(specialist.allowedTools.length).toBeGreaterThan(0);
      for (const tool of specialist.allowedTools) {
        expect(KNOWN_CAPABILITIES.has(tool)).toBe(true);
      }
    }
  });

  it("only roles that draft outbound get the write capability", () => {
    for (const specialist of SPECIALIST_ROSTER) {
      if (specialist.allowedTools.includes("gmail.send")) {
        expect(["support-responder"]).toContain(specialist.slug);
      }
    }
  });

  it("profile names round-trip through the slug", () => {
    for (const specialist of SPECIALIST_ROSTER) {
      const name = specialistProfileName(specialist.slug);
      expect(specialistSlugFromProfileName(name)).toBe(specialist.slug);
      expect(specialistBySlug(specialist.slug)).toEqual(specialist);
    }
    expect(specialistSlugFromProfileName("alfred")).toBeNull();
    expect(specialistBySlug("not-a-role")).toBeNull();
  });
});
