import { Suspense } from "react";
import { connection } from "next/server";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/empty-state";
import { PageHeader, Section } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { getAuthContext } from "@/lib/auth";
import { eveBridgeUnavailableReason } from "@/domains/agents/eve-driver";
import { pageRunsWithProfile, listSpecialistProfiles, RUN_STATES, type RunStateFilter } from "@/domains/agents/queries";
import { redirectPastEnd } from "@/components/list/clamp";
import { ListToolbar } from "@/components/list/list-toolbar";
import { NoResults } from "@/components/list/no-results";
import { Pagination } from "@/components/list/pagination";
import { listHref, matchesQuery, offsetFor, parseListParams, type RawSearchParams } from "@/lib/list-params";
import { SPECIALIST_ROSTER, SPECIALIST_TEAMS, specialistProfileName } from "@/domains/agents/roster";
import { CreateSpecialistForm, HireForm, InstallButton } from "./specialist-controls";

export const metadata = { title: "Specialists · Polymath" };

/*
 * The bench: browse the roster, add specialists, hire them onto a run, and see
 * what hired runs did. The roster ships with the repo (src/domains/agents/
 * roster.ts); installing materializes a role into agent_profiles, and hiring
 * starts a run against that profile through the same engine Alfred uses, so
 * budget, policy snapshot and audit are identical.
 */

const stateLabel: Record<string, string> = {
  queued: "Queued",
  running: "Running",
  waiting_input: "Waiting for input",
  waiting_approval: "Waiting for approval",
  succeeded: "Succeeded",
  failed: "Failed",
  cancelled: "Cancelled",
};

const BASE = "/alfred/specialists";

export async function SpecialistsSurface({ searchParams = Promise.resolve({}) }: { searchParams?: Promise<RawSearchParams> } = {}) {
  await connection();
  if (!process.env.DATABASE_URL?.trim()) {
    return (
      <>
        <PageHeader title="Specialists" purpose="Hire an agent for the job." />
        <div className="page-content">
          <EmptyState
            title="Agent storage is not configured"
            description="Set DATABASE_URL and apply the database migrations to build a bench and hire specialists."
          />
        </div>
      </>
    );
  }
  const auth = await getAuthContext();
  const bench = await listSpecialistProfiles(auth.workspaceId);
  const raw = await searchParams;
  const roster = parseListParams(raw, { filters: { team: SPECIALIST_TEAMS } });
  const hires = parseListParams({ ...raw, page: raw.rpage }, { filters: { state: RUN_STATES }, qKey: "rq", defaultPageSize: 10 });
  const found = await pageRunsWithProfile(auth.workspaceId, {
    query: hires.q,
    state: hires.filters.state as RunStateFilter | undefined,
    limit: hires.pageSize,
    offset: offsetFor(hires.page, hires.pageSize),
  });
  redirectPastEnd(BASE, raw, hires.page, hires.pageSize, found.total, "rpage");
  const runs = found.items;
  const hiresFiltered = Boolean(hires.q || hires.filters.state);
  const visibleTeams = SPECIALIST_TEAMS.filter((team) => !roster.filters.team || roster.filters.team === team);
  const rosterMatches = (team: string) =>
    SPECIALIST_ROSTER.filter((sp) => sp.team === team && matchesQuery(roster.q, sp.name, sp.mission));
  const rosterTotal = visibleTeams.reduce((n, team) => n + rosterMatches(team).length, 0);
  const installed = new Set(bench.map((p) => p.name));
  const unavailable = eveBridgeUnavailableReason();

  return (
    <>
      <PageHeader title="Specialists" purpose="Hire an agent for the job." />
      <div className="flex flex-col gap-6 page-content">
        <Section
          title="Your bench"
          description="Specialists you can hire. A hire is a run: it starts with the specialist's stated tools, model, and budget, and it cannot exceed them."
        >
          {bench.length === 0 ? (
            <EmptyState title="No specialists yet" description="Add one from the roster below, or define your own." />
          ) : (
            <ul className="flex flex-col divide-y divide-border">
              {bench.map((profile) => (
                <li key={profile.id} className="flex flex-col gap-2 py-3 first:pt-0 last:pb-0">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <p className="text-[13px] font-medium">{profile.description ?? profile.name}</p>
                    <div className="flex gap-1">
                      {(Array.isArray(profile.allowedTools) ? (profile.allowedTools as string[]) : []).map((tool) => (
                        <Badge key={tool} variant="secondary" className="font-normal">
                          {tool}
                        </Badge>
                      ))}
                    </div>
                  </div>
                  <HireForm profileName={profile.name} disabled={Boolean(unavailable)} />
                </li>
              ))}
            </ul>
          )}
          {unavailable ? (
            <p role="status" className="text-muted-foreground text-[13px]">
              {unavailable}
            </p>
          ) : null}
        </Section>

        <Section
          title="Roster"
          description="Thirty specialists across seven teams. Adding one puts it on your bench with its stated tool scope."
        >
          <ListToolbar
            pageKeys={[]}
            searchPlaceholder="Search the roster"
            filters={[{ key: "team", label: "Team", allLabel: "All teams", options: SPECIALIST_TEAMS.map((t) => ({ value: t, label: t })) }]}
            total={rosterTotal}
            noun={rosterTotal === 1 ? "specialist" : "specialists"}
          />
          {rosterTotal === 0 ? (
            <NoResults
              filtered
              clearHref={listHref(BASE, raw, { q: undefined, team: undefined })}
              emptyTitle=""
              emptyDescription=""
            />
          ) : null}
          <div className="flex flex-col gap-5">
            {visibleTeams.filter((team) => rosterMatches(team).length > 0).map((team) => (
              <div key={team} className="flex flex-col gap-2">
                <h3 className="text-muted-foreground text-xs font-medium tracking-wide uppercase">{team}</h3>
                <ul className="flex flex-col divide-y divide-border rounded-md border border-border">
                  {rosterMatches(team).map((specialist) => (
                    <li key={specialist.slug} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2.5">
                      <div className="flex min-w-0 flex-col">
                        <p className="text-[13px] font-medium">{specialist.name}</p>
                        <p className="text-muted-foreground text-xs">{specialist.mission}</p>
                      </div>
                      <InstallButton slug={specialist.slug} installed={installed.has(specialistProfileName(specialist.slug))} />
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </Section>

        <Section title="Define your own" description="A custom specialist is a name, a mission, and a brief, with the tool scope you grant.">
          <CreateSpecialistForm />
        </Section>

        <Section title="Recent hires" description="Every run shows who ran it and how it ended.">
          {found.total > 0 || hiresFiltered ? (
            <ListToolbar
              qKey="rq"
              pageKeys={["rpage"]}
              searchPlaceholder="Search hires"
              filters={[{ key: "state", label: "State", allLabel: "All states", options: RUN_STATES.map((v) => ({ value: v, label: stateLabel[v] ?? v })) }]}
              total={found.total}
              noun={found.total === 1 ? "run" : "runs"}
            />
          ) : null}
          {runs.length === 0 ? (
            <NoResults
              filtered={hiresFiltered}
              clearHref={listHref(BASE, raw, { rq: undefined, state: undefined, rpage: undefined })}
              emptyTitle="No runs yet"
              emptyDescription="Hire a specialist above to start the first run."
            />
          ) : (
            <ul className="flex flex-col divide-y divide-border">
              {runs.map((run) => (
                <li key={run.id} className="flex flex-col gap-1 py-3 first:pt-0 last:pb-0">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <p className="text-[13px]">{run.objective}</p>
                    <Badge variant="secondary" className="font-normal">
                      {stateLabel[run.state] ?? run.state}
                    </Badge>
                  </div>
                  <p className="text-muted-foreground text-xs">
                    {run.profileName ?? "unknown agent"} · {run.summary ?? run.error ?? "in progress"}
                  </p>
                </li>
              ))}
            </ul>
          )}
          <Pagination basePath={BASE} raw={raw} page={hires.page} pageSize={hires.pageSize} total={found.total} pageParam="rpage" />
        </Section>
      </div>
    </>
  );
}

export default function SpecialistsPage({ searchParams }: { searchParams: Promise<RawSearchParams> }) {
  return (
    <Suspense fallback={<SpecialistsSkeleton />}>
      <SpecialistsSurface searchParams={searchParams} />
    </Suspense>
  );
}

function SpecialistsSkeleton() {
  return (
    <div role="status" aria-label="Loading Specialists" className="flex flex-1 flex-col gap-4 p-6">
      <Skeleton className="h-6 w-40" />
      <Skeleton className="h-4 w-full max-w-xl" />
      <Skeleton className="h-40" />
    </div>
  );
}
