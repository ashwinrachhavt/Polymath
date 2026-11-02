import { and, eq, isNull } from "drizzle-orm";
import { modelRateCards } from "@/domains/spending/schema";
import { MODEL_CATALOG } from "@/domains/agents/models";
import { db } from "@/lib/db";
import { workspaces } from "@/domains/identity/tables";

/*
 * Rate-card seed for every model in the catalog (MODEL_CATALOG), one open
 * card per provider+model. Run manually — prices are operator data, not
 * code:
 *
 *   pnpm seed:rate-cards                    dry run, prints the plan
 *   pnpm seed:rate-cards -- --apply         writes
 *   pnpm seed:rate-cards -- --apply --workspace <uuid>
 *
 * Re-running after editing a rate below closes the old card (valid_to = now)
 * and opens the new one — past usage events keep the card that priced them,
 * so history is never rewritten. Re-running with unchanged rates is a no-op.
 *
 * Every rate carries its source. Free-tier providers are seeded at $0: that
 * is what the workspace's keys actually cost on those tiers (the catalog's
 * `probe` notes name the tier for each). When a route moves off a free tier,
 * edit its rate here and re-run with --apply — the change prices new events
 * only.
 */

type Rate = {
  /** USD per million tokens, `numeric(12,6)`-shaped strings. */
  inputPerMillion: string;
  outputPerMillion: string;
  /** Null cache rate = cache tokens price at the input rate. */
  cacheReadPerMillion?: string;
  cacheWritePerMillion?: string;
  /** Where this number came from. */
  source: string;
};

/** Per-model rates; the provider comes from the catalog entry. */
const RATES: Record<string, Rate> = {
  // OpenAI — developers.openai.com/api/docs/pricing (retrieved 2026-11-02):
  // gpt-6.1-terra $1.00 input / $0.05 cached input / $5.00 output;
  // gpt-5.4-mini $0.75 / $0.075 / $4.50. Cached-input read rates are exact;
  // there is no default cache-write charge, so cache writes fall back to the
  // input rate (over-states cost rather than understating it).
  "gpt-6.1-terra": {
    inputPerMillion: "1.000000",
    outputPerMillion: "5.000000",
    cacheReadPerMillion: "0.050000",
    source: "openai.com pricing docs, 2026-11-02",
  },
  "gpt-5.4-mini": {
    inputPerMillion: "0.750000",
    outputPerMillion: "4.500000",
    cacheReadPerMillion: "0.075000",
    source: "openai.com pricing docs, 2026-11-02",
  },

  // OpenRouter — live listed pricing for the exact route ids, from
  // GET https://openrouter.ai/api/v1/models (retrieved 2026-11-02, per-token
  // prices times 1e6):
  "deepseek/deepseek-chat": {
    inputPerMillion: "0.257400",
    outputPerMillion: "1.028700",
    source: "openrouter.ai/api/v1/models, 2026-11-02",
  },
  "deepseek/deepseek-v3.2": {
    inputPerMillion: "0.260000",
    outputPerMillion: "0.380000",
    cacheReadPerMillion: "0.130000",
    source: "openrouter.ai/api/v1/models, 2026-11-02",
  },

  // Everything below runs on a free tier or grant — the catalog's probe notes
  // name the tier ("Free tier, fast", "free developer tier", "free trial key",
  // "Free mode", "EU free tier", "100M free-token grant"). $0 until the
  // operator moves a route to paid; then edit + re-run.
  "gemini-3.5-flash-lite": {
    inputPerMillion: "0.000000",
    outputPerMillion: "0.000000",
    source: "free tier (catalog note)",
  },
  "openai/gpt-oss-120b": {
    inputPerMillion: "0.000000",
    outputPerMillion: "0.000000",
    source: "free tier (catalog note)",
  },
  "qwen/qwen3.8-27b": { inputPerMillion: "0.000000", outputPerMillion: "0.000000", source: "free tier (catalog note)" },
  "meta/llama-3.2-11b-vision-instruct": {
    inputPerMillion: "0.000000",
    outputPerMillion: "0.000000",
    source: "free tier (catalog note)",
  },
  "nvidia/nemotron-3.5-lightning-30b-a3b": {
    inputPerMillion: "0.000000",
    outputPerMillion: "0.000000",
    source: "free tier (catalog note)",
  },
  "nvidia/nemotron-3-ultra-550b-a55b": {
    inputPerMillion: "0.000000",
    outputPerMillion: "0.000000",
    source: "free tier (catalog note)",
  },
  "openai/gpt-oss-20b": {
    inputPerMillion: "0.000000",
    outputPerMillion: "0.000000",
    source: "free tier (catalog note)",
  },
  "deepseek-ai/deepseek-v4.1-flash": {
    inputPerMillion: "0.000000",
    outputPerMillion: "0.000000",
    source: "free tier (catalog note)",
  },
  "command-r7b-12-2024": {
    inputPerMillion: "0.000000",
    outputPerMillion: "0.000000",
    source: "free trial key (catalog note)",
  },
  "command-a-reasoning-08-2025": {
    inputPerMillion: "0.000000",
    outputPerMillion: "0.000000",
    source: "free trial key (catalog note)",
  },
  "mistral-small-latest": {
    inputPerMillion: "0.000000",
    outputPerMillion: "0.000000",
    source: "free mode (catalog note)",
  },
  "codestral-latest": { inputPerMillion: "0.000000", outputPerMillion: "0.000000", source: "free mode (catalog note)" },
  "Qwen3.5-397B-A17B": {
    inputPerMillion: "0.000000",
    outputPerMillion: "0.000000",
    source: "free tier (catalog note)",
  },
  "glm-4.7-flash": { inputPerMillion: "0.000000", outputPerMillion: "0.000000", source: "free tier (catalog note)" },
  "glm-4.5-flash": { inputPerMillion: "0.000000", outputPerMillion: "0.000000", source: "free tier (catalog note)" },
  "mercury-3": { inputPerMillion: "0.000000", outputPerMillion: "0.000000", source: "free-token grant (catalog note)" },
  // Catalog has both ovh/gpt-oss-120b and groq/openai/gpt-oss-120b — distinct
  // (provider, model) pairs, each gets its own card.
  "gpt-oss-120b": { inputPerMillion: "0.000000", outputPerMillion: "0.000000", source: "free tier (catalog note)" },
};

type Plan = {
  provider: string;
  model: string;
  inputPerMillion: string;
  outputPerMillion: string;
  cacheReadPerMillion: string | null;
  cacheWritePerMillion: string | null;
  action: "insert" | "replace-open-card" | "unchanged";
  source: string;
};

async function resolveWorkspace(explicit: string | null): Promise<{ id: string; name: string }> {
  if (explicit) {
    const [row] = await db
      .select({ id: workspaces.id, name: workspaces.name })
      .from(workspaces)
      .where(and(eq(workspaces.id, explicit), isNull(workspaces.archivedAt)))
      .limit(1);
    if (!row) throw new Error(`No active workspace with id ${explicit}`);
    return row;
  }
  const rows = await db
    .select({ id: workspaces.id, name: workspaces.name })
    .from(workspaces)
    .where(isNull(workspaces.archivedAt));
  if (rows.length === 1) return rows[0]!;
  throw new Error(
    rows.length === 0
      ? "No active workspace found. Create one first or pass --workspace <uuid>."
      : `Multiple active workspaces (${rows.map((r) => r.name).join(", ")}). Pass --workspace <uuid>.`,
  );
}

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const workspaceFlag = args.includes("--workspace") ? args[args.indexOf("--workspace") + 1]! : null;

  const url = process.env.DATABASE_URL ?? "";
  if (!url) throw new Error("DATABASE_URL is not set. Run with --env-file=.env (the seed:rate-cards script does).");

  const workspace = await resolveWorkspace(workspaceFlag);

  const cards = MODEL_CATALOG.flatMap((entry) => {
    const rate = RATES[entry.id];
    if (!rate) return []; // a catalog entry with no seeded rate prices as unpriced
    return [{ provider: entry.provider, model: entry.id, rate }];
  });
  if (cards.length !== Object.keys(RATES).length) {
    const orphans = Object.keys(RATES).filter((id) => !MODEL_CATALOG.some((entry) => entry.id === id));
    if (orphans.length) throw new Error(`RATES names models missing from the catalog: ${orphans.join(", ")}`);
  }

  const plan: Plan[] = [];
  for (const { provider, model, rate } of cards) {
    const [open] = await db
      .select({
        id: modelRateCards.id,
        inputPerMillion: modelRateCards.inputPerMillion,
        outputPerMillion: modelRateCards.outputPerMillion,
        cacheReadPerMillion: modelRateCards.cacheReadPerMillion,
        cacheWritePerMillion: modelRateCards.cacheWritePerMillion,
      })
      .from(modelRateCards)
      .where(
        and(
          eq(modelRateCards.workspaceId, workspace.id),
          eq(modelRateCards.provider, provider),
          eq(modelRateCards.model, model),
          isNull(modelRateCards.validTo),
        ),
      )
      .limit(1);

    const unchanged =
      open !== undefined &&
      open.inputPerMillion === rate.inputPerMillion &&
      open.outputPerMillion === rate.outputPerMillion &&
      (open.cacheReadPerMillion ?? null) === (rate.cacheReadPerMillion ?? null) &&
      (open.cacheWritePerMillion ?? null) === (rate.cacheWritePerMillion ?? null);

    plan.push({
      provider,
      model,
      inputPerMillion: rate.inputPerMillion,
      outputPerMillion: rate.outputPerMillion,
      cacheReadPerMillion: rate.cacheReadPerMillion ?? null,
      cacheWritePerMillion: rate.cacheWritePerMillion ?? null,
      action: unchanged ? "unchanged" : open ? "replace-open-card" : "insert",
      source: rate.source,
    });
  }

  const now = new Date();
  for (const item of plan) {
    console.log(
      `${item.action.padEnd(18)} ${item.provider} ${item.model} in=${item.inputPerMillion} out=${item.outputPerMillion} (${item.source})`,
    );
  }

  if (!apply) {
    console.log(`\nDry run for workspace ${workspace.name}: ${plan.length} cards. Re-run with --apply to write.`);
    return;
  }

  const inserts = plan.filter((item) => item.action !== "unchanged");
  for (const item of inserts) {
    await db.transaction(async (tx) => {
      // Close the open card, then open the new one: the instant of the change
      // belongs to the new card, and no moment is covered by two.
      if (item.action === "replace-open-card") {
        const [open] = await tx
          .select({ id: modelRateCards.id })
          .from(modelRateCards)
          .where(
            and(
              eq(modelRateCards.workspaceId, workspace.id),
              eq(modelRateCards.provider, item.provider),
              eq(modelRateCards.model, item.model),
              isNull(modelRateCards.validTo),
            ),
          )
          .limit(1);
        if (open) {
          await tx.update(modelRateCards).set({ validTo: now, updatedAt: now }).where(eq(modelRateCards.id, open.id));
        }
      }
      await tx
        .insert(modelRateCards)
        .values({
          workspaceId: workspace.id,
          provider: item.provider,
          model: item.model,
          inputPerMillion: item.inputPerMillion,
          outputPerMillion: item.outputPerMillion,
          cacheReadPerMillion: item.cacheReadPerMillion,
          cacheWritePerMillion: item.cacheWritePerMillion,
          effectiveFrom: now,
        })
        // The unique key (workspace, provider, model, effective_from) makes a
        // re-run at the same instant a no-op.
        .onConflictDoNothing();
    });
  }
  console.log(
    `\nApplied for workspace ${workspace.name}: ${inserts.length} written, ${plan.length - inserts.length} already current.`,
  );
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
