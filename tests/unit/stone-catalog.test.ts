import { readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import drawnStones from "@/components/stones/drawn-stones.json";
import { loadCatalog, TIER_BANDS } from "../../scripts/stones/catalog";

/*
 * The catalog's own integrity, before any database: 200 distinct stones,
 * each priced inside its tier's band on the band's step, every band above
 * the one below it, diamond and gold at the top, and the drawn-art manifest
 * matching the files on disk (undrawn stones show a placeholder).
 */

const catalog = loadCatalog();
const TIER_ORDER = ["crystal", "semi_precious", "precious", "legendary"] as const;

describe("stone catalog", () => {
  it("has 200 stones with unique slugs and names", () => {
    expect(catalog).toHaveLength(200);
    expect(new Set(catalog.map((s) => s.slug)).size).toBe(200);
    expect(new Set(catalog.map((s) => s.name.toLowerCase())).size).toBe(200);
  });

  it("fills each tier to its count and prices it inside the tier's band", () => {
    for (const [tier, band] of Object.entries(TIER_BANDS)) {
      const group = catalog.filter((s) => s.tier === tier);
      expect(group, tier).toHaveLength(band.count);
      for (const stone of group) {
        expect(stone.price, stone.slug).toBeGreaterThanOrEqual(band.min);
        expect(stone.price, stone.slug).toBeLessThanOrEqual(band.max);
        expect(stone.price % band.step, stone.slug).toBe(0);
      }
    }
  });

  it("prices every tier above every stone of the tier below", () => {
    for (let i = 1; i < TIER_ORDER.length; i += 1) {
      const lower = Math.max(...catalog.filter((s) => s.tier === TIER_ORDER[i - 1]).map((s) => s.price));
      const upper = Math.min(...catalog.filter((s) => s.tier === TIER_ORDER[i]).map((s) => s.price));
      expect(upper, `${TIER_ORDER[i]} over ${TIER_ORDER[i - 1]}`).toBeGreaterThan(lower);
    }
  });

  it("puts diamond and gold at the top, diamond first", () => {
    const [first, second] = [...catalog].sort((a, b) => b.price - a.price);
    expect([first.slug, second.slug]).toEqual(["diamond", "gold"]);
  });

  it("is listed in wall order: by tier, then price, then name", () => {
    const sorted = [...catalog].sort(
      (a, b) =>
        TIER_ORDER.indexOf(b.tier) - TIER_ORDER.indexOf(a.tier) || b.price - a.price || a.name.localeCompare(b.name),
    );
    expect(catalog.map((s) => s.slug)).toEqual(sorted.map((s) => s.slug));
  });

  it("frames every lore line as tradition, not as a claim", () => {
    const framing =
      /folklore|tradition|legend|said|believed|held|lapidar|lore|myth|ancient|medieval|custom|associated|considered|revered|prized|called|named|thought|attributed|regarded|according|story|tale|amulet|talisman|superstition|belief/i;
    for (const stone of catalog) expect(stone.lore, stone.slug).toMatch(framing);
  });

  it("lists exactly the drawn stones in the manifest, each a catalog stone small enough to ship", () => {
    const dir = resolve(import.meta.dirname, "../../public/stones");
    const files = readdirSync(dir)
      .filter((name) => name.endsWith(".webp"))
      .map((name) => name.slice(0, -".webp".length))
      .sort();
    expect(drawnStones).toEqual(files);
    const slugs = new Set(catalog.map((s) => s.slug));
    for (const slug of drawnStones) {
      expect(slugs.has(slug), slug).toBe(true);
      expect(statSync(resolve(dir, `${slug}.webp`)).size, slug).toBeLessThan(120 * 1024);
    }
  });
});
