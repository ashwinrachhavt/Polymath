import Link from "next/link";
import { Suspense } from "react";
import { connection } from "next/server";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/empty-state";
import { PageHeader, Section } from "@/components/page-header";
import { Readout } from "@/components/readout";
import { getAuthContext } from "@/lib/auth";
import { listSkills } from "@/domains/skills/queries";
import { BUNDLED_SKILLS } from "@/domains/skills/bundled";
import { redirectPastEnd } from "@/components/list/clamp";
import { ListToolbar } from "@/components/list/list-toolbar";
import { NoResults } from "@/components/list/no-results";
import { Pagination } from "@/components/list/pagination";
import { listHref, matchesQuery, paginate, parseListParams, type RawSearchParams } from "@/lib/list-params";
import { AddSkillForm } from "./add-skill-form";
import { InstallExample, RemoveSkillButton, SkillToggle, UseSkill } from "./skill-controls";
import { READINESS_FILTERS, skillReadiness } from "./readiness";

export const metadata = { title: "Skills · Polymath" };

/*
 * The skills library: a procedure the assistant follows, imported from a
 * GitHub repository, a local folder, or one of the three examples that ship
 * with the app. A skill supplies instructions only; the run's tool scope still
 * comes from its frozen policy, so adding one cannot widen what the assistant
 * may do.
 *
 * Everything on this page reads Neon. The one client state is the Add skill
 * form's inspection, which is deliberately not stored anywhere.
 */

const BASE = "/alfred/skills";

/**
 * Readiness is derived, never stored: a row that exists is Ready unless it has
 * been switched off. The vocabulary is fixed by the ticket (`Ready`,
 * `Disabled`, and the four setup states a later slice can report); the filter
 * offers only the two this slice can produce.
 */
function readinessValue(enabled: boolean): (typeof READINESS_FILTERS)[number] {
  return enabled ? "ready" : "disabled";
}

function shortRevision(revision: string): string {
  return revision.length > 8 ? revision.slice(0, 8) : revision;
}

const installedDate = new Intl.DateTimeFormat("en", { year: "numeric", month: "short", day: "numeric" });

export async function SkillsSurface({
  searchParams = Promise.resolve({}),
}: {
  searchParams?: Promise<RawSearchParams>;
} = {}) {
  await connection();
  if (!process.env.DATABASE_URL?.trim()) {
    return (
      <>
        <PageHeader title="Skills" purpose="Give the assistant a procedure to follow." />
        <div className="page-content">
          <EmptyState
            title="Skill storage is not configured"
            description="Set DATABASE_URL and apply the database migrations to install skills and pin them to runs."
          />
        </div>
      </>
    );
  }

  const auth = await getAuthContext();
  const raw = await searchParams;
  const list = parseListParams(raw, { filters: { readiness: READINESS_FILTERS }, defaultPageSize: 25 });
  const installed = await listSkills(auth);
  const installedIdentities = new Set(installed.map((skill) => `${skill.sourceKind}:${skill.sourcePath}`));

  const matching = installed.filter(
    (skill) =>
      matchesQuery(list.q, skill.name, skill.description, skill.sourceRef) &&
      (!list.filters.readiness || list.filters.readiness === readinessValue(skill.enabled)),
  );
  redirectPastEnd(BASE, raw, list.page, list.pageSize, matching.length);
  const page = paginate(matching, list.page, list.pageSize);
  const filtered = Boolean(list.q || list.filters.readiness);
  const enabledCount = installed.filter((skill) => skill.enabled).length;

  return (
    <>
      <PageHeader
        title="Skills"
        purpose="Give the assistant a procedure to follow."
        actions={
          <Readout className="text-muted-foreground text-xs">
            {enabledCount} ready of {installed.length}
          </Readout>
        }
      />
      <div className="flex flex-col gap-6 page-content">
        <Section
          title="Add a skill"
          description="Paste a github.com link, a supported install command, or a folder path. Inspect first: nothing is stored until you install a package."
        >
          <AddSkillForm />
        </Section>

        <Section
          title="My skills"
          description="A skill is a procedure, never authority. A run that pins one keeps that revision for its whole life, even after you edit or remove it here."
        >
          {installed.length === 0 ? (
            <EmptyState
              title="No skills yet"
              description="Add one above, for example github.com/anthropics/skills, or install an example from Discover below."
            />
          ) : (
            <>
              <ListToolbar
                pageKeys={["page"]}
                searchPlaceholder="Search skills"
                filters={[
                  {
                    key: "readiness",
                    label: "Readiness",
                    allLabel: "All skills",
                    options: [
                      { value: "ready", label: "Ready" },
                      { value: "disabled", label: "Disabled" },
                    ],
                  },
                ]}
                total={matching.length}
                noun={matching.length === 1 ? "skill" : "skills"}
              />
              {page.items.length === 0 ? (
                <NoResults
                  filtered={filtered}
                  clearHref={listHref(BASE, raw, { q: undefined, readiness: undefined })}
                  emptyTitle=""
                  emptyDescription=""
                />
              ) : (
                <ul className="divide-border flex flex-col divide-y">
                  {page.items.map((skill) => {
                    const readiness = skillReadiness(skill);
                    return (
                      <li key={skill.id} className="flex flex-col gap-2 py-3 first:pt-0 last:pb-0">
                        <div className="flex flex-wrap items-baseline justify-between gap-2">
                          <div className="flex min-w-0 flex-col">
                            <Link
                              href={`/alfred/skills/${skill.id}`}
                              className="text-[13px] font-medium underline-offset-4 hover:underline"
                            >
                              {skill.name}
                            </Link>
                            <p className="text-muted-foreground text-xs">{skill.description}</p>
                          </div>
                          <Badge variant={skill.enabled ? "secondary" : "outline"} className="font-normal">
                            {readiness}
                          </Badge>
                        </div>
                        <p className="text-muted-foreground readout text-xs">
                          {skill.sourceKind}: {skill.sourceRef} · {shortRevision(skill.revision)} ·{" "}
                          {skill.files.length + 1} {skill.files.length === 0 ? "file" : "files"} · installed{" "}
                          {installedDate.format(skill.createdAt)}
                        </p>
                        {skill.warnings.length > 0 ? (
                          <ul className="flex flex-col gap-0.5">
                            {skill.warnings.map((warning) => (
                              <li key={warning} className="text-muted-foreground text-xs">
                                {warning}
                              </li>
                            ))}
                          </ul>
                        ) : null}
                        <UseSkill id={skill.id} name={skill.name} disabled={!skill.enabled} />
                        <div className="flex flex-wrap items-center gap-2">
                          <SkillToggle id={skill.id} name={skill.name} enabled={skill.enabled} />
                          <RemoveSkillButton id={skill.id} name={skill.name} />
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
              <Pagination basePath={BASE} raw={raw} page={page.page} pageSize={list.pageSize} total={page.total} />
            </>
          )}
        </Section>

        <Section
          title="Discover"
          description="Three procedures that ship with Polymath. Installing one copies it into your library; it is no different from an imported skill after that."
        >
          <ul className="divide-border flex flex-col divide-y rounded-md border border-border">
            {BUNDLED_SKILLS.map((skill) => (
              <li key={skill.slug} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2.5">
                <div className="flex min-w-0 flex-col">
                  <p className="text-[13px] font-medium">{skill.name}</p>
                  <p className="text-muted-foreground text-xs">{skill.description}</p>
                </div>
                <InstallExample
                  slug={skill.slug}
                  installed={installedIdentities.has(`bundled:${skill.sourcePath}`)}
                />
              </li>
            ))}
          </ul>
        </Section>
      </div>
    </>
  );
}

export default function SkillsPage({ searchParams }: { searchParams: Promise<RawSearchParams> }) {
  return (
    <Suspense fallback={<SkillsSkeleton />}>
      <SkillsSurface searchParams={searchParams} />
    </Suspense>
  );
}

function SkillsSkeleton() {
  return (
    <div role="status" aria-label="Loading Skills" className="flex flex-1 flex-col gap-4 p-6">
      <Skeleton className="h-6 w-40" />
      <Skeleton className="h-4 w-full max-w-xl" />
      <Skeleton className="h-40" />
    </div>
  );
}
