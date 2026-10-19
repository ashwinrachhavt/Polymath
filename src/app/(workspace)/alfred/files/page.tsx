import { Suspense } from "react";
import { connection } from "next/server";
import { Skeleton } from "@/components/ui/skeleton";
import { PageHeader } from "@/components/page-header";
import { getAuthContext } from "@/lib/auth";
import { getDocumentInbox } from "@/domains/knowledge/queries";
import { getOrganisation, listFolders } from "@/domains/knowledge/folders";
import type { BrowserRow } from "@/domains/knowledge/file-browser";
import { FileExplorer } from "./file-explorer";

export const metadata = { title: "Files · Axiom" };

/*
 * The document engine as a file manager: smart folders, list and grid, instant
 * search, a preview pane with evidence and history, bulk actions, and drag and
 * drop upload. Every row is a canonical document; this page only reads them.
 * Sharing is a surface with nothing behind it yet and says so.
 */

const LIMIT = 300;

async function FilesSurface() {
  await connection();
  const auth = await getAuthContext();
  const rows = await getDocumentInbox(auth, { limit: LIMIT });
  const [folders, organisation] = await Promise.all([listFolders(auth), getOrganisation(auth, rows.map((r) => r.id))]);
  const initial: BrowserRow[] = rows.map((r) => ({
    id: r.id,
    title: r.title,
    filename: r.filename,
    mimeType: r.mimeType,
    createdAt: r.createdAt.toISOString(),
    sourceUrl: r.sourceUrl,
    kind: r.kind,
    extractionStatus: r.extractionStatus,
    undecidedProposals: r.undecidedProposals,
    partyNames: r.partyNames,
    folderId: organisation.folderByDocument.get(r.id) ?? null,
    tags: organisation.tagsByDocument.get(r.id) ?? [],
  }));
  return <FileExplorer initialRows={initial} folders={folders.map((f) => ({ id: f.id, name: f.name, version: f.version }))} truncated={rows.length >= LIMIT} />;
}

export default function FilesPage() {
  return (
    <div className="flex flex-col">
      <PageHeader title="Files" purpose="Every document you have added, organised for finding, reading and reviewing." />
      <Suspense
        fallback={
          <div className="flex flex-col gap-3 px-4 py-6 md:px-6">
            <Skeleton className="h-8 w-1/2" />
            <Skeleton className="h-5 w-full" />
            <Skeleton className="h-5 w-full" />
            <Skeleton className="h-5 w-2/3" />
          </div>
        }
      >
        <FilesSurface />
      </Suspense>
    </div>
  );
}
