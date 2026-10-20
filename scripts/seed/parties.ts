import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { resolveSeedOwner } from "@/domains/crm/seed";
import { seedParties } from "@/domains/identity/party-seed";

/*
 * Identity-party seed for a local development database. The evidence file is
 * the owner's own inventory and is never committed (see .gitignore: outreach/).
 *
 *   pnpm seed:parties                       dry run, prints the plan
 *   pnpm seed:parties -- --apply            writes
 *   pnpm seed:parties -- --file x.json --clerk-user user_...
 */

type Args = { apply: boolean; allowRemote: boolean; file: string; clerkUser: string | null };

function parseArgs(argv: string[]): Args {
  const args: Args = { apply: false, allowRemote: false, file: "outreach/seed/parties-2026-10-19.json", clerkUser: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--apply") args.apply = true;
    else if (arg === "--allow-remote") args.allowRemote = true;
    else if (arg === "--file") args.file = argv[++i];
    else if (arg === "--clerk-user") args.clerkUser = argv[++i];
    else if (arg === "--help") {
      console.log("pnpm seed:parties [--apply] [--file path] [--clerk-user id] [--allow-remote]");
      process.exit(0);
    }
  }
  return args;
}

function isLocalDatabase(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return host === "localhost" || host === "127.0.0.1" || host === "::1";
  } catch {
    return false;
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const url = process.env.DATABASE_URL ?? "";
  if (!url) throw new Error("DATABASE_URL is not set. Copy .env.example to .env first.");
  if (!isLocalDatabase(url) && !args.allowRemote) {
    throw new Error(
      `Refusing to write personal data to a non-local database (${new URL(url).hostname}). Pass --allow-remote if that is really the target.`,
    );
  }

  const clerkUser = args.clerkUser ?? process.env.SEED_CLERK_USER_ID ?? "";
  if (!clerkUser) {
    throw new Error("Pass --clerk-user <clerk_id> or set SEED_CLERK_USER_ID. The seed never guesses an owner.");
  }

  const auth = await resolveSeedOwner(clerkUser);
  if (!auth) {
    throw new Error(`No active workspace membership for ${clerkUser}. Check the id or sign in once first.`);
  }

  const raw = JSON.parse(await readFile(resolve(args.file), "utf8"));
  const summary = await seedParties(auth, raw, { apply: args.apply });

  console.log(JSON.stringify(summary, null, 2));
  if (!args.apply) console.log("\nDry run only. Re-run with --apply to write.");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
