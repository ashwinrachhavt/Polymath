import { Suspense } from "react";
import { z } from "zod";
import { io } from "next/cache";
import { Skeleton } from "@/components/ui/skeleton";
import { PageHeader } from "@/components/page-header";
import { getAuthContext } from "@/lib/auth";
import { getExplorerPage } from "@/domains/knowledge/file-rows";
import { listFolders } from "@/domains/knowledge/library";
import { FileExplorer } from "./file-explorer";

export const metadata = { title: "Files · Polymath" };

/*
 * The document engine as a file manager: smart folders, list and grid, instant
 * search, a preview pane with evidence and history, bulk actions, and drag and
 * drop upload. Every row is a canonical document; this page only reads them.
 * Sharing is a surface with nothing behind it yet and says so.
 */

type SearchParams = Promise<{ task?: string | string[] }>;

/** `?task=<uuid>` narrows the explorer to the documents that produced that task. Anything else is no filter. */
function taskFilterFrom(raw: string | string[] | undefined): string | undefined {
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value && z.string().uuid().safeParse(value).success ? value : undefined;
}

async function FilesSurface({ searchParams }: { searchParams: SearchParams }) {
  await io();
  const taskId = taskFilterFrom((await searchParams).task);
  const auth = await getAuthContext();
  const [page, folders] = await Promise.all([
    getExplorerPage(auth, { sort: "added", limit: 100, taskId }),
    listFolders(auth),
  ]);
  return (
    <FileExplorer
      initialRows={page.rows}
      initialCursor={page.nextCursor}
      total={page.total}
      folders={folders}
      taskId={taskId}
    />
  );
}

export default function FilesPage({ searchParams }: { searchParams: SearchParams }) {
  return (
    <div className="flex flex-col">
      <PageHeader title="Files" />
      <Suspense
        fallback={
          <div className="flex flex-col gap-3 page-content">
            <Skeleton className="h-8 w-1/2" />
            <Skeleton className="h-5 w-full" />
            <Skeleton className="h-5 w-full" />
            <Skeleton className="h-5 w-2/3" />
          </div>
        }
      >
        <FilesSurface searchParams={searchParams} />
      </Suspense>
    </div>
  );
}
