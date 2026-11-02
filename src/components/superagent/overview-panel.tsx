/**
 * The Overview: the panel's answer to "what needs a person now" (docs/008).
 * Everything here is a read — the only people command on this surface is a
 * Decision's dismissal, which goes through the Engine like every other
 * domain write.
 */
import { reasonText } from "@/domains/superagent/core/reasons";
import { attentionEffects, createSuperagentStore, getPolicy, unavailableDecisions } from "@/domains/superagent/store";
import { db } from "@/lib/db";
import { getAuthContext } from "@/lib/auth";
import { Empty, Panel } from "@/components/workspace/ui";
import { DismissButton } from "./dismiss-button";
import { PersonStageCard } from "./tickets-view";
import { superviseTickets } from "./view";

function formatDate(at: Date | string): string {
  return new Date(at).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });
}

export async function OverviewPanel() {
  const auth = await getAuthContext();
  const store = createSuperagentStore(db, auth.workspaceId);
  await store.hydrate();
  const [groups, decisions, effects, policy] = await Promise.all([
    Promise.resolve(superviseTickets(store.repositories.tickets.list())),
    unavailableDecisions(db, auth.workspaceId),
    attentionEffects(db, auth.workspaceId),
    getPolicy(db, auth.workspaceId),
  ]);
  const paused = policy?.policy.paused ?? false;
  const personGroups = groups.filter((group) => group.waitingOn === "person" && group.tickets.length > 0);

  if (personGroups.length === 0 && decisions.length === 0 && effects.length === 0 && !paused) {
    return (
      <Empty
        title="Nothing needs a person"
        description="The agent is not waiting on you. Work it is running shows in Tickets."
      />
    );
  }

  return (
    <div className="flex flex-col gap-6">
      {paused ? (
        <Panel title="Paused" description="The agent admits no new work until the policy is resumed.">
          <p className="text-muted-foreground text-xs">
            Tickets already accepted keep their mandates and may still run. Resume in Settings.
          </p>
        </Panel>
      ) : null}

      {personGroups.length > 0 ? (
        <section className="flex flex-col gap-3" aria-label="Needs a person">
          <h2 className="text-muted-foreground text-[13px] font-medium">Needs a person</h2>
          <div className="flex flex-col gap-3">
            {personGroups.map((group) => (
              <PersonStageCard key={group.key} group={group} />
            ))}
          </div>
        </section>
      ) : null}

      {decisions.length > 0 ? (
        <Panel title="Could not decide" description="The assessor gave up on these after two requeues.">
          <ul className="flex flex-col" aria-label="Unavailable decisions">
            {decisions.map((decision) => (
              <li
                key={decision.id}
                className="border-border not-last:border-b flex items-start justify-between gap-3 py-2.5"
              >
                <span className="min-w-0 text-sm">
                  <span className="text-muted-foreground block text-xs">
                    {formatDate(decision.at)} · thread {decision.threadKey}
                  </span>
                  {reasonText(decision.reason)}
                </span>
                <DismissButton decisionId={decision.id} />
              </li>
            ))}
          </ul>
        </Panel>
      ) : null}

      {effects.length > 0 ? (
        <Panel title="Delivery health" description="Effects that failed three times in a row and are still queued.">
          <ul className="flex flex-col" aria-label="Effect health">
            {effects.map((effect) => (
              <li key={effect.id} className="border-border not-last:border-b py-2.5 text-sm">
                <span className="readout text-[11px] opacity-80">{effect.kind}</span>{" "}
                <span className="text-muted-foreground break-all text-xs">{effect.key}</span>
                {effect.lastError ? (
                  <span className="text-muted-foreground mt-0.5 block text-xs">{effect.lastError}</span>
                ) : null}
              </li>
            ))}
          </ul>
        </Panel>
      ) : null}
    </div>
  );
}
