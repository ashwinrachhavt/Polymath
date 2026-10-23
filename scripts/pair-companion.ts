import { eq } from "drizzle-orm";
import { resolveSeedOwner } from "@/domains/crm/seed";
import { mintApiClient } from "@/domains/identity/machine";
import { apiClients } from "@/domains/identity/schema";
import { db } from "@/lib/db";

/*
 * Pairs the Chrome companion with this Polymath workspace. The same flow is
 * available in the app under Settings → Account and machine clients, which is
 * the easier path; this CLI remains for headless setups and recovery.
 *
 * Only the secret's SHA-256 digest is stored; the token is printed once. No
 * third-party API-key product is involved, so it works on any Clerk plan.
 * Revocation is `--revoke`, which archives the row.
 *
 *   pnpm companion:pair -- --clerk-user user_xxx
 *   pnpm companion:pair -- --clerk-user user_xxx --revoke <clientId>
 */

type Args = { clerkUser: string | null; name: string; revoke: string | null };

function parseArgs(argv: string[]): Args {
  const args: Args = { clerkUser: null, name: "Chrome companion", revoke: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--clerk-user") args.clerkUser = argv[++i] ?? null;
    else if (argv[i] === "--name") args.name = argv[++i] ?? args.name;
    else if (argv[i] === "--revoke") args.revoke = argv[++i] ?? null;
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.revoke) {
    const [row] = await db.select().from(apiClients).where(eq(apiClients.id, args.revoke)).limit(1);
    if (!row) throw new Error(`No api_client ${args.revoke}.`);
    await db
      .update(apiClients)
      .set({ status: "revoked", archivedAt: new Date() })
      .where(eq(apiClients.id, row.id));
    console.log(`Revoked ${row.name} (${row.id}). Its secret no longer authenticates.`);
    return;
  }

  if (!args.clerkUser) throw new Error("Pass --clerk-user user_xxx (the owner's Clerk id).");
  const owner = await resolveSeedOwner(args.clerkUser);
  if (!owner) throw new Error(`No active workspace for ${args.clerkUser}. Sign in to Polymath once first.`);

  const minted = await mintApiClient({
    workspaceId: owner.workspaceId,
    name: args.name,
    kind: "companion",
    // The companion reads its queue (health check, history) and writes
    // captures, so it needs both halves of the captures surface.
    scopes: ["captures:read", "captures:write"],
  });

  console.log(`Paired ${minted.clientId} to workspace ${owner.workspaceId}.\n`);
  console.log("Paste this into the extension's Settings → Access token (shown once):\n");
  console.log(`  ${minted.token}\n`);
  console.log(`To revoke: pnpm companion:pair -- --revoke ${minted.clientId}\n`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
