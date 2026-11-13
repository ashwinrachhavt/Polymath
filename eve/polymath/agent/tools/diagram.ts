import { defineTool } from "eve/tools";
import { z } from "zod";
import { toolAllowed } from "../lib/policy";
// Relative, not "@/...": eve bundles this agent from its own package root and
// does not carry the app's tsconfig paths (see hooks/bridge.ts).
import { getRunBySessionRef } from "../../../../src/domains/agents/queries";
import {
  DIAGRAM_CREATE_CAPABILITY,
  DIAGRAM_TYPES,
  DiagramError,
  diagramToolPayload,
  guardMermaidSource,
  persistDiagram,
} from "../../../../src/domains/diagrams/diagrams";
import { runSessionRef } from "../lib/run-session";

/*
 * Generates or refines a diagram from Mermaid the model authors itself
 * (spec art_Yi8Fwsqn: Mermaid is the generation format; the LLM never authors
 * raw Excalidraw JSON). Persistence is immediate and append-only — the
 * refinement loop needs generate-and-see, and version history is the
 * reversibility — so this tool is the rare internal write that creates real
 * artifacts without a review queue. The run's frozen policy must allow
 * diagram.create.
 *
 * The structural guard (guardMermaidSource) rejects malformed source with an
 * agent-readable error BEFORE anything is written, which is what the caller's
 * one-shot self-correction pass consumes. The result payload stays lean —
 * ids plus the Mermaid source (when it fits the frame cap) — because the
 * heavy conversion to an editable Excalidraw scene happens client-side.
 */
export default defineTool({
  description:
    "Generate or refine a diagram and persist it as a versioned diagram artifact. Author valid Mermaid (flowchart or sequence preferred); the tool guards it, stores it, and returns the ids. Call with no targetCanvasId to create a new diagram, or pass the canvasId from an earlier result to refine that existing diagram with a new version.",
  inputSchema: z.object({
    title: z.string().min(1).max(120),
    mermaid: z.string().min(1).max(20_000),
    diagramType: z.enum(DIAGRAM_TYPES),
    targetCanvasId: z.string().uuid().optional(),
  }),
  async execute(input, ctx) {
    const current = ctx.session.auth.current;
    const workspaceId = current?.attributes?.workspaceId;
    if (typeof workspaceId !== "string" || !current?.principalId) {
      return { ok: false as const, error: "no workspace in session" };
    }
    const run = await getRunBySessionRef(runSessionRef(ctx.session), workspaceId);
    if (!run || run.state !== "running") {
      return { ok: false as const, error: "no active Polymath run bound to this session" };
    }
    if (!toolAllowed(run.policySnapshot, DIAGRAM_CREATE_CAPABILITY)) {
      return { ok: false as const, error: "diagram.create is not in this run's policy snapshot" };
    }
    const guarded = guardMermaidSource(input.mermaid);
    if (!guarded.ok) return { ok: false as const, error: guarded.error };
    try {
      const persisted = await persistDiagram(
        // The DiagramAuth surface carries only identity — the run's frozen
        // policy (checked above) is the real authorization gate.
        { userId: current.principalId, workspaceId },
        {
          title: input.title,
          mermaid: guarded.mermaid,
          diagramType: input.diagramType,
          runId: run.id,
          canvasId: input.targetCanvasId,
        },
      );
      return diagramToolPayload({ ...persisted, diagramType: input.diagramType, mermaid: guarded.mermaid });
    } catch (cause) {
      if (cause instanceof DiagramError) return { ok: false as const, error: cause.message };
      return { ok: false as const, error: "diagram persistence failed" };
    }
  },
});
