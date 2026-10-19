import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { resolveSeedOwner } from "@/domains/crm/seed";
import { apiClients } from "@/domains/identity/schema";
import { db } from "@/lib/db";
import { sha256Hex } from "@/lib/hash";

/*
 * Pairs the Chrome companion with this Axiom workspace.
 *
 * Axiom resolves a machine token by looking its digest up in
 * api_clients.token_hash, but nothing ever created those rows. This is that
 * missing step: mint a secret, store only its SHA-256 digest, and print the
 * secret once. No third-party API-key product is involved, so it works on any
 * Clerk plan; revocation is `--revoke`, which archives the row.
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
  if (!owner) throw new Error(`No active workspace for ${args.clerkUser}. Sign in to Axiom once first.`);

  const secret = `axm_${randomBytes(32).toString("base64url")}`;
  const [client] = await db
    .insert(apiClients)
    .values({
      workspaceId: owner.workspaceId,
      name: args.name,
      kind: "companion",
      tokenHash: await sha256Hex(secret),
      status: "active",
      scopes: ["captures:write"],
    })
    .returning({ id: apiClients.id });

  console.log(`Paired ${client.id} to workspace ${owner.workspaceId}.\n`);
  console.log("Paste this into the extension's Settings → Access token (shown once):\n");
  console.log(`  ${secret}\n`);
  console.log(`To revoke: pnpm companion:pair -- --revoke ${client.id}\n`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
