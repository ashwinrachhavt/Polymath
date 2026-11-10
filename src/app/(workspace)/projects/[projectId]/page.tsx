import { Suspense } from "react";
import { redirect } from "next/navigation";
import { Skeleton } from "@/components/ui/skeleton";

export const metadata = { title: "Notebook · Polymath" };

/*
 * A project opens its Notebook: sources, learning and results live there, so
 * the project address goes straight to it instead of showing a second screen
 * with a link to the first. The params promise is read inside the boundary,
 * so the shell still paints first.
 */
export default function ProjectPage({ params }: { params: Promise<{ projectId: string }> }) {
  return (
    <Suspense fallback={<Skeleton className="m-6 h-64 w-full" />}>
      <OpenNotebook params={params} />
    </Suspense>
  );
}

async function OpenNotebook({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  redirect(`/projects/${projectId}/notebook`);
  return null;
}
