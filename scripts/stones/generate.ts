import { and, eq } from "drizzle-orm";
import { resolveSeedOwner } from "@/domains/crm/seed";
import { proposeStone } from "@/domains/gamification/proposals";
import { foundryKeyForRecipeName, rejectRecipe, stoneRecipeSchema } from "@/domains/gamification/recipe";
import { rewardDefinitions } from "@/domains/gamification/schema";
import { generationProvider, GenerationUnconfiguredError } from "@/integrations/generation/provider";
import { db } from "@/lib/db";

/*
 * The stone foundry's design step (spec §7): turn a theme into one stone
 * recipe through the generation seam (mercury-first, json: true) and propose
 * it to the owner's review queue. Nothing here writes a definition - the
 * approval in the reviews UI does, and this command only queues the recipe.
 *
 * The generated JSON is never trusted: the shared zod schema is the boundary,
 * so a design that misses the shape dies here with the reason, never in the
 * renderer. A stone whose name maps to an existing `gen-` key is refused -
 * the namespace is one stone per slug, and a re-run with the same theme
 * resolves the same dedupe key rather than queueing a second proposal.
 *
 *   pnpm stones:generate -- --clerk-user user_xxx --theme "finishing a deep session"
 *
 * Doubles as the catalog probe: a successful run is a live model turn whose
 * output validated against the stone schema.
 */

type Args = { clerkUser: string | null; theme: string | null; rarity: string | null };

function parseArgs(argv: string[]): Args {
  const args: Args = { clerkUser: null, theme: null, rarity: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--clerk-user") args.clerkUser = argv[++i] ?? null;
    else if (argv[i] === "--theme") args.theme = argv[++i] ?? null;
    else if (argv[i] === "--rarity") args.rarity = argv[++i] ?? null;
  }
  return args;
}

const SYSTEM = `You design one collectible stone for Polymath's foundry. Return JSON with exactly this shape:
{"name": string, "rarity": string, "theme": string, "palette": [hex, ...], "svg": string}
"name": a short evocative name (max 60 chars), e.g. "Amethyst of Patience". Never reuse a name the collection already has.
"rarity": one of "Common", "Rare", "Epic", "Legendary".
"theme": one line (max 120 chars) saying what the stone commemorates.
"palette": 3 to 5 six-digit hex colors, darkest first - the stone's body palette.
"svg": the stone as a single vector, exactly 200x200: the opening tag must carry viewBox="0 0 200 200". Draw a rounded mineral shard or pebble from the palette - layered paths or gradients read well at small sizes; no text, no <script>, no event handlers, no href or external references, no nested data payloads. Keep it under 4000 characters.
Return JSON and nothing else.`;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.clerkUser) throw new Error("Pass --clerk-user user_xxx (the owner's Clerk id).");
  if (!args.theme) throw new Error('Pass --theme "what the stone commemorates".');
  const owner = await resolveSeedOwner(args.clerkUser);
  if (!owner) throw new Error(`No active workspace for ${args.clerkUser}. Sign in to Polymath once first.`);

  const provider = generationProvider();
  const prompt = [
    `Design a stone commemorating: ${args.theme}`,
    args.rarity
      ? `Its rarity tier is fixed: ${args.rarity}.`
      : "Choose the rarity that fits the effort the moment deserves.",
  ].join("\n");

  let out: { text: string };
  try {
    out = await provider.generate({ system: SYSTEM, prompt, json: true });
  } catch (cause) {
    if (cause instanceof GenerationUnconfiguredError) {
      throw new Error(
        "No generation provider configured. MERCURY_API_KEY (or GEMINI_API_KEY / OPENROUTER_API_KEY) must be set.",
      );
    }
    throw cause;
  }

  // The probe boundary: the model's answer must satisfy the exact schema the
  // eve tool and the approval path enforce.
  let raw: unknown;
  try {
    raw = JSON.parse(out.text);
  } catch {
    throw new Error("The model returned an unreadable answer (not JSON).");
  }
  const rejection = rejectRecipe(raw);
  if (rejection) {
    console.error(`Stone rejected by the recipe schema: ${rejection.field}: ${rejection.message}`);
    process.exit(1);
  }
  const recipe = stoneRecipeSchema.parse(raw);

  const key = foundryKeyForRecipeName(recipe.name);
  const [existing] = await db
    .select({ id: rewardDefinitions.id, label: rewardDefinitions.label })
    .from(rewardDefinitions)
    .where(and(eq(rewardDefinitions.workspaceId, owner.workspaceId), eq(rewardDefinitions.key, key)))
    .limit(1);
  if (existing) {
    console.log(`"${recipe.name}" maps to ${key}, already in the collection as "${existing.label}" (${existing.id}).`);
    console.log("The gen- namespace is one stone per slug - rerun with a theme that yields a different name.");
    return;
  }

  const proposed = await proposeStone(owner, { ...recipe, dedupeId: key });
  console.log(
    `Proposed ${key} for review: ${proposed.proposalId}${proposed.deduplicated ? " (deduplicated: proposal already queued)" : ""}`,
  );
  console.log(`Approve it on the rewards page (Foundry section) to add "${recipe.name}" to the collection.`);
}

main()
  .then(() => process.exit(0))
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
