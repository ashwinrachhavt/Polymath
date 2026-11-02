import { describe, expect, it } from "vitest";
import {
  foundryKeyForRecipeName,
  FOUNDRY_KEY_PREFIX,
  recipeToDataUrl,
  rejectRecipe,
  slugForRecipeName,
  STONE_SVG_MAX_CHARS,
  STONE_SVG_SIZE,
  stoneRecipeSchema,
} from "@/domains/gamification/recipe";

/*
 * The recipe schema is the foundry's security boundary (spec §7): everything
 * that renders a stone treats the recipe as hostile input until these checks
 * pass. These tests pin the rejections - a malformed design never reaches a
 * proposal, a definition, or the DOM.
 */

const VALID_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200">' +
  '<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">' +
  '<stop offset="0" stop-color="#7C3AED"/><stop offset="1" stop-color="#C4B5FD"/>' +
  "</linearGradient></defs>" +
  '<path d="M100 20 L170 90 L100 180 L30 90 Z" fill="url(#g)"/>' +
  "</svg>";

const VALID_RECIPE = {
  name: "Amethyst of Patience",
  rarity: "Rare",
  theme: "Deep work that holds",
  palette: ["#7C3AED", "#A78BFA", "#C4B5FD"],
  svg: VALID_SVG,
};

describe("stone recipe schema", () => {
  it("accepts a well-formed recipe", () => {
    const parsed = stoneRecipeSchema.parse(VALID_RECIPE);
    expect(parsed.name).toBe("Amethyst of Patience");
    expect(parsed.palette).toHaveLength(3);
  });

  it("rejects scripts, event handlers, external references, and nested payloads", () => {
    const hostile: Array<[string, string]> = [
      ["script", '<svg viewBox="0 0 200 200"><script>alert(1)</script></svg>'],
      ["event handler", '<svg viewBox="0 0 200 200"><circle onload="x()" r="5"/></svg>'],
      ["external reference", '<svg viewBox="0 0 200 200"><a href="https://nope.invalid"><text>x</text></a></svg>'],
      ["nested payload", '<svg viewBox="0 0 200 200"><image data:image/png;base64,AAAA/></svg>'],
      ["javascript url", '<svg viewBox="0 0 200 200"><rect fill="javascript:alert(1)"/></svg>'],
    ];
    for (const [label, svg] of hostile) {
      expect(rejectRecipe({ ...VALID_RECIPE, svg }), label).toMatchObject({ field: "svg" });
    }
  });

  it("pins the design canvas", () => {
    expect(rejectRecipe({ ...VALID_RECIPE, svg: '<svg viewBox="0 0 100 100"><path d="M0 0"/></svg>' })).toMatchObject({
      field: "svg",
    });
    expect(rejectRecipe({ ...VALID_RECIPE, svg: '<g viewBox="0 0 200 200"/>' })).toMatchObject({ field: "svg" });
    expect(STONE_SVG_SIZE).toBe(200);
  });

  it("bounds the jsonb payload", () => {
    const padded = `${VALID_SVG}${"<!-- ".concat("x".repeat(64), " -->").repeat(60)}`;
    expect(padded.length).toBeGreaterThan(STONE_SVG_MAX_CHARS);
    expect(rejectRecipe({ ...VALID_RECIPE, svg: padded })).toMatchObject({ field: "svg" });
  });

  it("requires three to five six-digit hex palette entries", () => {
    // A bad entry reports its own index (palette.0); a bad array length
    // reports the palette itself. Either way the field names the palette.
    for (const palette of [
      ["#7C3AED", "#A78BFA"],
      ["#7C3AED", "#A78BFA", "#C4B5FD", "#DDD6FE", "#EDE9FE", "#F5F3FF"],
    ]) {
      expect(rejectRecipe({ ...VALID_RECIPE, palette })?.field).toBe("palette");
    }
    for (const palette of [
      ["#fff", "#A78BFA", "#C4B5FD"],
      ["purple", "#A78BFA", "#C4B5FD"],
      ["#GGGGGG", "#A78BFA", "#C4B5FD"],
    ]) {
      expect(rejectRecipe({ ...VALID_RECIPE, palette })?.field).toMatch(/^palette/);
    }
  });

  it("demands a name, a theme, and a known rarity", () => {
    expect(rejectRecipe({ ...VALID_RECIPE, name: "   " })).toMatchObject({ field: "name" });
    expect(rejectRecipe({ ...VALID_RECIPE, name: "a".repeat(61) })).toMatchObject({ field: "name" });
    expect(stoneRecipeSchema.parse({ ...VALID_RECIPE, name: "a".repeat(60) }).name).toHaveLength(60);
    expect(rejectRecipe({ ...VALID_RECIPE, theme: "" })).toMatchObject({ field: "theme" });
    expect(rejectRecipe({ ...VALID_RECIPE, rarity: "Mythic" })).toMatchObject({ field: "rarity" });
  });

  it("reports one flat rejection, or null for a valid recipe", () => {
    expect(rejectRecipe(VALID_RECIPE)).toBeNull();
    const rejection = rejectRecipe({ ...VALID_RECIPE, svg: "<not-svg/>" });
    expect(rejection).toEqual({ field: "svg", message: expect.any(String) });
  });
});

describe("foundry key namespace", () => {
  it("slugs a name into the gen- namespace, deterministically", () => {
    expect(foundryKeyForRecipeName("Amethyst of Patience")).toBe(`${FOUNDRY_KEY_PREFIX}amethyst-of-patience`);
    expect(foundryKeyForRecipeName("Amethyst of Patience")).toBe(foundryKeyForRecipeName("amethyst   of -- Patience!"));
  });

  it("collapses diacritics and punctuation, and falls back when nothing survives", () => {
    expect(slugForRecipeName("Mémoire de Sel")).toBe("memoire-de-sel");
    expect(slugForRecipeName("  🪨  ")).toBe("stone");
  });

  it("keeps genuinely distinct names distinct", () => {
    // Case and punctuation variants collapse by design - that is what makes
    // the slug a dedupe key.
    const keys = ["Patience", "Patience II", "Perseverance", "Grit"].map(foundryKeyForRecipeName);
    expect(new Set(keys).size).toBe(keys.length);
    expect(foundryKeyForRecipeName("PATIENCE!")).toBe(foundryKeyForRecipeName("patience"));
  });
});

describe("recipe rendering", () => {
  it("ships the svg as a data URL that decodes back byte for byte", () => {
    const url = recipeToDataUrl(VALID_SVG);
    expect(url.startsWith("data:image/svg+xml;charset=utf-8,")).toBe(true);
    expect(decodeURIComponent(url.replace("data:image/svg+xml;charset=utf-8,", ""))).toBe(VALID_SVG);
  });
});
