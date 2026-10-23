import { defineTool } from "eve/tools";
import { z } from "zod";
import { toolAllowed } from "../lib/policy";
// Relative, not "@...": eve bundles this agent from its own package root and
// does not carry the app's tsconfig paths (see hooks/bridge.ts).
import { getRunBySessionRef } from "../../../../src/domains/agents/queries";
import { NOTEBOOK_OPEN_CAPABILITY, openNotebook } from "../../../../src/domains/knowledge/notebook-context";

/*
 * Read capability: open a notebook (a dossier) and see what it holds.
 *
 * Returns the sources with their ingest readiness and the artifacts the
 * notebook has already generated. A source still being embedded is named as
 * such, because an agent that cites it is citing something search cannot see
 * yet. Nothing here writes.
 */
export default defineTool({
  description:
    "Open a notebook (a bounded set of sources) and list its sources with their readiness, plus the reports, decks and infographics it has already generated. Use this before answering questions about a notebook so you know what is actually searchable. Read-only; the run's frozen policy must allow notebook.open.",
  inputSchema: z.object({
    dossierId: z.string().uuid().describe("The notebook (dossier) id."),
  }),
  async execute(input, ctx) {
    const current = ctx.session.auth.current;
    const workspaceId = current?.attributes?.workspaceId;
    if (typeof workspaceId !== "string" || !current?.principalId) {
      return { ok: false as const, error: "no workspace in session" };
    }
    const run = await getRunBySessionRef(ctx.session.id, workspaceId);
    if (!run || run.state !== "running") {
      return { ok: false as const, error: "no active Polymath run bound to this session" };
    }
    if (!toolAllowed(run.policySnapshot, NOTEBOOK_OPEN_CAPABILITY)) {
      return { ok: false as const, error: "notebook.open is not in this run's policy snapshot" };
    }
    const summary = await openNotebook(
      { userId: current.principalId, workspaceId, role: "viewer" },
      { dossierId: input.dossierId },
    );
    if (!summary) return { ok: false as const, error: "notebook not found" };
    return { ok: true as const, notebook: summary };
  },
});
