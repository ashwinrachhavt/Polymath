/**
 * Hand-run smoke probe for the superagent executor's eve seam against the
 * real dev stack (Postgres + the eve bridge): builds the real AgentEngine
 * the way POST /api/v1/runs does, wraps it in the seam, and either reports a
 * ticket run's live state (read-only) or starts one real run (--live).
 *
 *   pnpm tsx scripts/smoke/superagent-executor.ts <workspaceId> <userId> <ticketId> <runId> [--profile=polymath] [--live]
 *
 * Read-only mode proves the seam's subject queries against real rows.
 * --live proves the full launch path: one create-once eve run carrying the
 * ticket run's subjects, polled to a terminal state, then cancelled if it
 * is still active. The output is PR evidence for the executor PR's merge
 * gate (real-services smoke).
 */
import type { AuthContext } from "@/domains/identity/resolve";
import { createEveDriver, eveAgentForProfile } from "@/domains/agents/eve-driver";
import { createEngine } from "@/domains/agents/engine";
import { ACTIVE_RUN_STATES, createEveSeam } from "@/domains/superagent/executor/eve";

const args = process.argv.slice(2);
const [workspaceId, userId, ticketId, runId] = args.filter((a) => !a.startsWith("--"));
const live = args.includes("--live");
const profile = args.find((a) => a.startsWith("--profile="))?.slice("--profile=".length) ?? "polymath";

if (!workspaceId || !userId || !ticketId || !runId) {
  console.error(
    "usage: tsx scripts/smoke/superagent-executor.ts <workspaceId> <userId> <ticketId> <runId> [--profile=polymath] [--live]",
  );
  process.exit(2);
}

async function main() {
  const engine = createEngine(createEveDriver(eveAgentForProfile(profile)));
  const seam = createEveSeam(engine);
  const auth: AuthContext = { userId, workspaceId, role: "owner" };

  // Read-only first: what does the seam see for this ticket run right now?
  const liveRun = await seam.liveRun({ workspaceId, ticketId, runId });
  const last = await seam.lastRun({ workspaceId, ticketId, runId });
  console.log("live run:", liveRun ?? "none", "| last run:", last ?? "none");

  if (!live) {
    console.log("read-only probe done (pass --live to start a real run)");
    process.exit(0);
  }

  const { agentRunId } = await seam.start({
    workspaceId,
    auth,
    ticketId,
    runId,
    objective: `Smoke probe for ticket-run ${runId}: reply with the single word ready and do nothing else.`,
    profileName: profile,
    estimateUsd: "0.01",
  });
  console.log("started agent run:", agentRunId);

  for (let i = 0; i < 60; i++) {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    const state = (await seam.lastRun({ workspaceId, ticketId, runId }))?.state;
    console.log(`  poll ${i + 1}: ${state ?? "?"}`);
    if (state && !ACTIVE_RUN_STATES.includes(state)) {
      console.log("terminal state:", state);
      process.exit(0);
    }
  }
  console.log("still active after 120s — cancelling:", await seam.cancel({ workspaceId, auth, agentRunId }));
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
