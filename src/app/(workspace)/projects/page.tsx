import { Suspense } from "react";
import { connection } from "next/server";
import { Skeleton } from "@/components/ui/skeleton";
import { PageHeader } from "@/components/page-header";
import { getAuthContext } from "@/lib/auth";
import { listProjects } from "@/domains/knowledge/projects";
import { NewProjectButton, ProjectRow, SectionRow } from "./project-list-client";

export const metadata = { title: "Projects · Polymath" };

/*
 * The projects screen (Perplexity Spaces parity): pinned projects first, then
 * everything else. A project is a long-lived home for a body of work - its own
 * sources, instructions, connectors, automations and memory.
 */

export async function ProjectsSurface() {
  await connection();
  if (!process.env.DATABASE_URL?.trim()) {
    return (
      <>
        <PageHeader title="Projects" purpose="Long-lived homes for a body of work." />
        <div className="page-content text-muted-foreground text-[13px]">
          Set DATABASE_URL and apply the database migrations to use projects.
        </div>
      </>
    );
  }
  const auth = await getAuthContext();
  const projects = await listProjects(auth);
  const pinned = projects.filter((p) => p.pinnedAt);
  const rest = projects.filter((p) => !p.pinnedAt);

  return (
    <>
      <div className="flex items-center justify-between gap-4 border-b border-border px-6 py-4">
        <h1 className="text-lg font-medium">Projects</h1>
        <NewProjectButton />
      </div>
      <div className="flex flex-col gap-6 px-6 py-6">
        {projects.length === 0 ? (
          <p className="text-muted-foreground text-[13px]">
            No projects yet. Create one and it becomes the home for its sources, instructions and generated artifacts.
          </p>
        ) : (
          <>
            {pinned.length > 0 ? (
              <section aria-label="Pinned">
                <SectionRow label="Pinned" />
                <ul className="flex flex-col">
                  {pinned.map((project) => (
                    <ProjectRow key={project.id} project={project} />
                  ))}
                </ul>
              </section>
            ) : null}
            <section aria-label="Your projects">
              <SectionRow label="Your projects" />
              <ul className="flex flex-col">
                {rest.map((project) => (
                  <ProjectRow key={project.id} project={project} />
                ))}
              </ul>
            </section>
          </>
        )}
      </div>
    </>
  );
}

export default function ProjectsPage() {
  return (
    <Suspense fallback={<Skeleton className="m-6 h-64 w-full" />}>
      <ProjectsSurface />
    </Suspense>
  );
}
