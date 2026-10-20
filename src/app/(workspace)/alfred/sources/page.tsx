import { Suspense } from "react";
import { connection } from "next/server";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { getAuthContext } from "@/lib/auth";
import { listSources } from "@/domains/knowledge/source-readiness";
import SourceList from "./sources-surface";

export const metadata = { title: "Sources · Polymath" };

/*
 * /alfred/sources: the one place material enters the library (NotebookLM
 * parity, S2). Reads the workspace's documents and their derived readiness;
 * every mutation goes through the server actions, which queue work rather than
 * fetch inside the request.
 *
 * This surface is deliberately separate from Library, which is the reading view
 * over the same rows. Discovery and reading are different jobs.
 */

// Per-request data; streams inside the Suspense boundary in the default export.
export async function SourcesData() {
  await connection();
  if (!process.env.DATABASE_URL?.trim()) {
    return (
      <>
        <PageHeader title="Sources" purpose="Find and bring in the material you will study." />
        <EmptyState
          title="No database configured"
          description="Set DATABASE_URL to read and capture sources."
        />
      </>
    );
  }
  const auth = await getAuthContext();
  const sources = await listSources(auth, { limit: 100 });
  return <SourceList initialSources={sources} />;
}

export default function SourcesPage() {
  return (
    <Suspense fallback={<Skeleton className="m-6 h-64 w-full" />}>
      <SourcesData />
    </Suspense>
  );
}
