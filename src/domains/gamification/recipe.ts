import { z } from "zod";

/*
 * The foundry recipe (spec §7): the complete description of an ML-designed
 * stone, validated once at the parse boundary and carried as jsonb on the
 * reward definition. The module is pure on purpose - no database, no server
 * imports - so the generator command, the approval path, the eve tool and the
 * rewards page all parse the exact same shape, and a malformed recipe cannot
 * exist past this file.
 *
 * The SVG is model-written, so the schema is also the security boundary:
 * everything that renders it treats it as hostile input until these checks
 * pass (script tags, event handlers, external references), and the renderer
 * ships it inside an <img> data URL, where SVG scripts never run anyway.
 */

/** The canvas every foundry stone is designed on. */
export const STONE_SVG_SIZE = 200;

/** Foundry-created definitions live in their own key namespace: `gen-<slug>`. */
export const FOUNDRY_KEY_PREFIX = "gen-";

/** A bound on the jsonb payload: a 200×200 vector stone fits with room to spare. */
export const STONE_SVG_MAX_CHARS = 4_000;

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

/** `<svg` opening tag; the viewBox check pins the canvas. */
const SVG_OPENS = /^\s*(?:<\?xml[^>]*\?>\s*)?<svg[\s>]/i;

/** Exactly the design canvas: the viewBox the renderer sizes against. */
const SVG_VIEWBOX = new RegExp(`viewBox\\s*=\\s*["']0 0 ${STONE_SVG_SIZE} ${STONE_SVG_SIZE}["']`, "i");

/**
 * The hostile patterns a model-written SVG must never carry. `href=` (plain
 * and namespaced) is refused outright - internal references use `url(#id)`,
 * which the `url(` rule permits - so no SVG can point the renderer at
 * anything external or smuggle a nested data payload.
 */
const SVG_FORBIDDEN: RegExp[] = [
  /<script/i,
  /<foreignObject/i,
  /on\s*\w+\s*=/i,
  /javascript\s*:/i,
  /href\s*=/i,
  /data\s*:/i,
];

function hasHostileSvgContent(svg: string): boolean {
  return SVG_FORBIDDEN.some((pattern) => pattern.test(svg));
}

/**
 * Why a palette entry or the whole recipe failed, in the model's own words -
 * the generator surfaces this, the review card renders it.
 */
export type RecipeRejection = { field: string; message: string };

export const stoneRecipeSchema = z.object({
  name: z.string().trim().min(1).max(60).describe('The stone\'s display name, e.g. "Amethyst of Patience".'),
  rarity: z.enum(["Common", "Rare", "Epic", "Legendary"]).describe("Rarity, matching the static catalog's tiers."),
  theme: z
    .string()
    .trim()
    .min(1)
    .max(120)
    .describe("What the stone is about, in one line - the durable page renders it as the description."),
  palette: z
    .array(z.string().regex(HEX_COLOR, "Palette entries are 6-digit hex colors, e.g. #7C3AED."))
    .min(3)
    .max(5)
    .describe("Three to five hex colors the stone is drawn from, darkest first."),
  svg: z
    .string()
    .min(1)
    .max(STONE_SVG_MAX_CHARS)
    .refine((svg) => SVG_OPENS.test(svg), { message: "The svg must begin with an <svg> tag." })
    .refine((svg) => SVG_VIEWBOX.test(svg), {
      message: `The svg must carry viewBox="0 0 ${STONE_SVG_SIZE} ${STONE_SVG_SIZE}".`,
    })
    .refine((svg) => !hasHostileSvgContent(svg), {
      message: "The svg must not carry scripts, event handlers, external references, or nested data payloads.",
    })
    .describe(`A single vector stone drawn on a ${STONE_SVG_SIZE}×${STONE_SVG_SIZE} canvas.`),
});

export type StoneRecipe = z.infer<typeof stoneRecipeSchema>;

/** The revision payload's shape before the schema has judged it. */
export type StoneRecipeInput = z.input<typeof stoneRecipeSchema>;

/**
 * One failure at a time (zod's first issue) as a flat, printable rejection -
 * the review card and the generator script share this shape.
 */
function recipeRejection(error: z.ZodError<StoneRecipe>): RecipeRejection {
  const issue = error.issues[0];
  return {
    field: issue.path.map(String).join(".") || "recipe",
    message: issue.message,
  };
}

/** Parse, or say exactly why the recipe is malformed. Returns null when valid. */
export function rejectRecipe(input: unknown): RecipeRejection | null {
  const parsed = stoneRecipeSchema.safeParse(input);
  if (parsed.success) return null;
  return recipeRejection(parsed.error);
}

/** The URL-safe slug a foundry key is built from: "Amethyst of Patience" → "amethyst-of-patience". */
export function slugForRecipeName(name: string): string {
  const slug = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/g, "");
  return slug || "stone";
}

/** The definition key in the foundry namespace: `gen-<slug>`. */
export function foundryKeyForRecipeName(name: string): string {
  return `${FOUNDRY_KEY_PREFIX}${slugForRecipeName(name)}`;
}

/**
 * The recipe's SVG as the renderer ships it: a utf-8 data URL behind an
 * <img>, where SVG scripts do not execute. Isomorphic by construction (no
 * Buffer, no btoa), so the server render and the client hydration agree.
 */
export function recipeToDataUrl(svg: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}
