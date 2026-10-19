import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { companyNames, resolveSeedOwner, seedPersonalData } from "@/domains/crm/seed";

/*
 * Personal-data seed for a local development database. The evidence file is
 * the owner's own inventory and is never committed (see .gitignore: outreach/).
 *
 *   pnpm seed:personal                       dry run, prints the plan
 *   pnpm seed:personal -- --apply            writes
 *   pnpm seed:personal -- --file x.json --clerk-user user_...
 *
 * It refuses a non-local DATABASE_URL unless --allow-remote is passed, because
 * this is the one script whose job is to write personal data somewhere.
 */

type Args = { apply: boolean; allowRemote: boolean; file: string; clerkUser: string | null };

function parseArgs(argv: string[]): Args {
  const args: Args = { apply: false, allowRemote: false, file: "outreach/seed/companies-2026-10-18.json", clerkUser: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--apply") args.apply = true;
    else if (arg === "--allow-remote") args.allowRemote = true;
    else if (arg === "--file") args.file = argv[++i];
    else if (arg === "--clerk-user") args.clerkUser = argv[++i];
    else if (arg === "--help") {
      console.log("pnpm seed:personal [--apply] [--file path] [--clerk-user id] [--allow-remote]");
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
    throw new Error(`No active workspace membership for Clerk user ${clerkUser}. Sign in once, then re-run.`);
  }

  const raw = JSON.parse(await readFile(resolve(process.cwd(), args.file), "utf8"));
  console.log(`Target: ${new URL(url).host}${new URL(url).pathname}  workspace ${auth.workspaceId}`);
  console.log(`Mode:   ${args.apply ? "APPLY" : "DRY RUN (rolled back)"}`);
  console.log(`File:   ${args.file}\n`);

  const summary = await seedPersonalData(auth, raw, { apply: args.apply });
  console.log(JSON.stringify(summary, null, 2));

  if (args.apply) {
    const names = await companyNames(auth);
    console.log(`\nCompanies now visible to the query layer (${names.length}):`);
    for (const name of names) console.log(`  - ${name}`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
