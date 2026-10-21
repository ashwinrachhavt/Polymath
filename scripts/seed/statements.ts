import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { resolveSeedOwner } from "@/domains/crm/seed";
import { intakeFile, DocumentAlreadyHasFileError } from "@/domains/knowledge/intake";
import { validateFile } from "@/lib/file-validation";

/*
 * File the owner's own bank statement PDFs into their workspace so the ledger
 * work has real documents to read. Every file goes through intakeFile — the
 * same path the upload route uses — so blob storage, the file/document rows, the
 * audit event, and the extraction outbox row all behave as they would after a
 * browser upload. Nothing here writes rows by hand.
 *
 *   pnpm seed:statements -- --dir ~/Downloads --clerk-user user_...
 *   pnpm seed:statements -- --dir ~/Downloads --clerk-user user_... --apply
 *
 * Statement PDFs are personal data and are never committed; the source
 * directory is read in place and only the bytes are uploaded.
 */

type Args = {
  apply: boolean;
  allowRemote: boolean;
  dir: string;
  clerkUser: string | null;
  folder: string;
  match: RegExp;
};

function parseArgs(argv: string[]): Args {
  const args: Args = {
    apply: false,
    allowRemote: false,
    dir: path.join(process.env.HOME ?? ".", "Downloads"),
    clerkUser: null,
    folder: "Statements",
    match: /statement|bank|acct|account|sofi|icici|hdfc|loan/i,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--apply") args.apply = true;
    else if (arg === "--allow-remote") args.allowRemote = true;
    else if (arg === "--dir") args.dir = argv[++i];
    else if (arg === "--clerk-user") args.clerkUser = argv[++i];
    else if (arg === "--folder") args.folder = argv[++i];
    else if (arg === "--match") args.match = new RegExp(argv[++i], "i");
    else if (arg === "--help") {
      console.log(
        "pnpm seed:statements [--apply] [--dir path] [--clerk-user id] [--folder name] [--match regex] [--allow-remote]",
      );
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

  const { resolveFolderPath } = await import("@/domains/knowledge/folder-paths");
  const folder = await resolveFolderPath(auth, args.folder);

  const names = (await readdir(args.dir))
    .filter((name) => name.toLowerCase().endsWith(".pdf") && args.match.test(name))
    .sort();

  const rows: Array<{ file: string; status: string; documentId?: string; error?: string }> = [];
  for (const name of names) {
    const bytes = new Uint8Array(await readFile(path.join(args.dir, name)));
    const verdict = validateFile(bytes, name);
    if (!verdict.ok) {
      rows.push({ file: name, status: "rejected", error: verdict.reason });
      continue;
    }
    if (!args.apply) {
      rows.push({ file: name, status: "would upload" });
      continue;
    }
    try {
      const result = await intakeFile(auth, {
        bytes,
        filename: name,
        title: name.replace(/\.pdf$/i, ""),
        verdict,
        origin: "upload",
        folderId: folder.folderId,
      });
      rows.push({
        file: name,
        status: result.documentId ? "uploaded" : "quarantined",
        documentId: result.documentId ?? undefined,
      });
    } catch (cause) {
      if (cause instanceof DocumentAlreadyHasFileError) {
        rows.push({ file: name, status: "already present" });
        continue;
      }
      rows.push({ file: name, status: "failed", error: cause instanceof Error ? cause.message : String(cause) });
    }
  }

  console.log(JSON.stringify({ workspaceId: auth.workspaceId, folder: args.folder, applied: args.apply, rows }, null, 2));
  if (!args.apply) console.log("\nDry run only. Re-run with --apply to upload.");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
