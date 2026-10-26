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

/**
 * `?task=<uuid>` narrows the explorer to the documents linked to that task.
 * Three states, never a silent broadening: absent is no filter, a valid uuid
 * filters (even when it matches nothing), an invalid value is an empty,
 * clearly-labelled result - not the whole library.
 */
function taskFilterFrom(raw: string | string[] | undefined): { taskId?: string; invalid: boolean } {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value) return { invalid: false };
  return z.string().uuid().safeParse(value).success ? { taskId: value, invalid: false } : { invalid: true };
}

async function FilesSurface({ searchParams }: { searchParams: SearchParams }) {
  await io();
  const filter = taskFilterFrom((await searchParams).task);
  const auth = await getAuthContext();
  const [page, folders] = filter.invalid
    ? [{ rows: [], nextCursor: null, total: 0 }, await listFolders(auth)]
    : await Promise.all([
        getExplorerPage(auth, { sort: "added", limit: 100, taskId: filter.taskId }),
        listFolders(auth),
      ]);
  return (
    <FileExplorer
      initialRows={page.rows}
      initialCursor={page.nextCursor}
      total={page.total}
      folders={folders}
      taskId={filter.taskId}
      taskFilterInvalid={filter.invalid}
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
