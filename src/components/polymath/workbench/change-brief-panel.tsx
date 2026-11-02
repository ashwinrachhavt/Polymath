/*
 * The change brief panel (Workbench D2): what changed in the repository after an
 * agent-authored run, rendered as evidence tiers instead of a transcript. Presentational
 * only — the server loads the data (change-brief-queries.ts) and every section's
 * badge names the tier its claims stand on: the diff reads as observed, captured
 * tests as verified, a recorded decision as recorded, and the absence of one as
 * inferred. Nothing here is model-written; the disclosure line says so on every render.
 */
import { CircleCheck, CircleX } from "lucide-react";
import { CAPTURE_DISCLOSURE, type ChangeBriefData } from "@/domains/agents/change-brief";
import { timeAgo } from "@/lib/time";
import { EvidenceBadge, type EvidenceTier } from "./evidence-badge";
import { DiffView } from "./diff-view";

/** Paths shown per area before the list hands the reader to the diff. */
const MAX_PATHS_PER_AREA = 12;
/** Test rows shown before the list collapses to a count. */
const MAX_TEST_ROWS = 8;

export function ChangeBriefPanel({ brief }: { brief: ChangeBriefData }) {
  const { checkpoint, tierCounts } = brief;
  return (
    <section aria-label="Change brief" className="border-border/70 bg-muted/20 flex w-full flex-col gap-3 rounded-lg border px-4 py-3">
      <header className="flex items-baseline justify-between gap-2">
        <h2 className="text-muted-foreground text-[11px] font-medium tracking-wide uppercase">Change brief</h2>
        <p
          className="text-muted-foreground/80 text-[11px]"
          aria-label={`Evidence: ${tierCounts.grounded} grounded, ${tierCounts.inferred} inferred, ${tierCounts.hypothesis} hypotheses`}
        >
          {tierCounts.grounded} grounded · {tierCounts.inferred} inferred · {tierCounts.hypothesis} hypotheses
        </p>
      </header>

      <p className="text-muted-foreground text-[11px]">
        Checkpoint <code className="bg-muted rounded px-1 py-0.5">{checkpoint.commitSha.slice(0, 12)}</code> ·{" "}
        {checkpoint.baseCommitSha.slice(0, 12)}…{checkpoint.commitSha.slice(0, 12)} · captured {timeAgo(checkpoint.capturedAt)}
      </p>

      <OutcomeSection brief={brief} />
      <AreasSection brief={brief} />
      <BehaviorSection brief={brief} />
      <TestsSection brief={brief} />
      <DiffSection brief={brief} />
      <DecisionSection brief={brief} />

      <footer className="border-border/70 text-muted-foreground/80 border-t pt-2 text-[11px] italic">{CAPTURE_DISCLOSURE}</footer>
    </section>
  );
}

function SectionLabel({ label, tier }: { label: string; tier?: EvidenceTier }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <h3 className="text-muted-foreground text-[11px] font-medium tracking-wide uppercase">{label}</h3>
      {tier ? <EvidenceBadge tier={tier} /> : null}
    </div>
  );
}

function OutcomeSection({ brief }: { brief: ChangeBriefData }) {
  const project = brief.project;
  return (
    <div className="flex flex-col gap-1">
      <SectionLabel label="Requested outcome" tier={project?.intendedOutcome ? "recorded" : undefined} />
      {project ? (
        <p className="text-[13px] leading-6">
          {project.intendedOutcome ?? "The linked project states no intended outcome."}{" "}
          <span className="text-muted-foreground text-[11px]">— from project “{project.name}”</span>
        </p>
      ) : (
        <p className="text-muted-foreground text-[12px]">No project is linked to this run, so no requested outcome is on record.</p>
      )}
    </div>
  );
}

function AreasSection({ brief }: { brief: ChangeBriefData }) {
  return (
    <div className="flex flex-col gap-1">
      <SectionLabel label="Affected areas" tier="observed" />
      <ul className="flex flex-col gap-1">
        {brief.areas.map((area) => (
          <li key={area.area} className="text-[12px] leading-5">
            <span className="font-medium">{area.area}</span>
            <span className="text-muted-foreground">
              {" "}
              · {area.paths.length} path{area.paths.length === 1 ? "" : "s"}
            </span>
            <ul className="text-muted-foreground mt-0.5 font-mono text-[11px] leading-5">
              {area.paths.slice(0, MAX_PATHS_PER_AREA).map((path) => (
                <li key={path}>{path}</li>
              ))}
              {area.paths.length > MAX_PATHS_PER_AREA ? <li>… and {area.paths.length - MAX_PATHS_PER_AREA} more</li> : null}
            </ul>
          </li>
        ))}
      </ul>
    </div>
  );
}

function BehaviorSection({ brief }: { brief: ChangeBriefData }) {
  const { added, removed, modified } = brief.behavior;
  return (
    <div className="flex flex-col gap-1">
      <SectionLabel label="Behavior" tier="observed" />
      <p className="text-[12px] leading-5">
        {added.length} added · {removed.length} removed · {modified.length} modified in place
        <span className="text-muted-foreground"> — read at file level from the diff; paths not listed are unchanged by this checkpoint.</span>
      </p>
      {added.length > 0 || removed.length > 0 ? (
        <ul className="text-muted-foreground font-mono text-[11px] leading-5">
          {added.map((path) => (
            <li key={path}>
              <span className="text-success">+ </span>
              {path}
            </li>
          ))}
          {removed.map((path) => (
            <li key={path}>
              <span className="text-destructive">− </span>
              {path}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function TestsSection({ brief }: { brief: ChangeBriefData }) {
  const tests = brief.tests;
  return (
    <div className="flex flex-col gap-1">
      <SectionLabel label="Tests" tier={tests ? "verified" : undefined} />
      {tests === null ? (
        <p className="text-muted-foreground text-[12px]">
          None provided — nothing on record says this change was tested. Unchecked failures, if any, are unknown.
        </p>
      ) : (
        <>
          <p className="text-[12px] leading-5">
            {tests.filter((t) => t.ok).length} passed · {tests.filter((t) => !t.ok).length} failed
            <span className="text-muted-foreground"> — from the results file captured with this checkpoint.</span>
          </p>
          {tests.length <= MAX_TEST_ROWS ? (
            <ul className="flex flex-col gap-0.5">
              {[...tests]
                .sort((a, b) => Number(a.ok) - Number(b.ok))
                .map((test) => (
                  <li key={test.name} className="flex items-center gap-1.5 text-[12px] leading-5">
                    {test.ok ? (
                      <>
                        <CircleCheck aria-hidden className="text-success size-3.5 shrink-0" />
                        <span className="sr-only">passed</span>
                      </>
                    ) : (
                      <>
                        <CircleX aria-hidden className="text-destructive size-3.5 shrink-0" />
                        <span className="sr-only">failed</span>
                      </>
                    )}
                    <span className={test.ok ? "" : "text-destructive font-medium"}>{test.name}</span>
                  </li>
                ))}
            </ul>
          ) : (
            <p className="text-muted-foreground text-[11px]">{tests.length} captured tests; the full list is in the checkpoint record.</p>
          )}
        </>
      )}
    </div>
  );
}

function DiffSection({ brief }: { brief: ChangeBriefData }) {
  return (
    <div className="flex flex-col gap-1">
      <SectionLabel label="Diff" tier={brief.diffText ? "observed" : undefined} />
      {brief.diffText ? <DiffView diffText={brief.diffText} /> : <p className="text-muted-foreground text-[12px]">{brief.diffUnavailableReason ?? "No diff is on record."}</p>}
    </div>
  );
}

function DecisionSection({ brief }: { brief: ChangeBriefData }) {
  const tier: EvidenceTier = brief.checkpoint.decisionStatus === "recorded" ? "recorded" : "inferred";
  return (
    <div className="flex flex-col gap-1">
      <SectionLabel label="Decision" tier={tier} />
      <p className="text-[13px] leading-6">{brief.decisionLine}</p>
    </div>
  );
}
