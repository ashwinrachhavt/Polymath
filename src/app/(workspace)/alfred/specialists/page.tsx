import { connection } from "next/server";
import { EmptyState } from "@/components/empty-state";
import { PageHeader, Section } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { getAuthContext } from "@/lib/auth";
import { eveBridgeUnavailableReason } from "@/domains/agents/eve-driver";
import { listRecentRunsWithProfile, listSpecialistProfiles } from "@/domains/agents/queries";
import { SPECIALIST_ROSTER, SPECIALIST_TEAMS, specialistProfileName } from "@/domains/agents/roster";
import { CreateSpecialistForm, HireForm, InstallButton } from "./specialist-controls";

export const metadata = { title: "Specialists · Axiom" };

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

export default async function SpecialistsPage() {
  await connection();
  if (!process.env.DATABASE_URL?.trim()) {
    return (
      <>
        <PageHeader title="Specialists" purpose="Hire an agent for the job." />
        <div className="px-4 py-5 md:px-6">
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
  const runs = await listRecentRunsWithProfile(auth.workspaceId, 8);
  const installed = new Set(bench.map((p) => p.name));
  const unavailable = eveBridgeUnavailableReason();

  return (
    <>
      <PageHeader title="Specialists" purpose="Hire an agent for the job." />
      <div className="flex flex-col gap-6 px-4 py-5 md:px-6">
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
          <div className="flex flex-col gap-5">
            {SPECIALIST_TEAMS.map((team) => (
              <div key={team} className="flex flex-col gap-2">
                <h3 className="text-muted-foreground text-xs font-medium tracking-wide uppercase">{team}</h3>
                <ul className="flex flex-col divide-y divide-border rounded-md border border-border">
                  {SPECIALIST_ROSTER.filter((s) => s.team === team).map((specialist) => (
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
          {runs.length === 0 ? (
            <EmptyState title="No runs yet" description="Hire a specialist above to start the first run." />
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
        </Section>
      </div>
    </>
  );
}
