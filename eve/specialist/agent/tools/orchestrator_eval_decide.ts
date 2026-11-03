import { defineTool } from "eve/tools";
import { z } from "zod";
import { resolveAssessment } from "../lib/assessor-bridge";

/*
 * The eval protocol's last step: decide. The assessor puts the recorded
 * judgment beside Mercury Decide's calibrated probability, hands the outcome
 * to the Engine — which opens the ticket or records the refusal — and
 * answers with what was decided and by which path. A refusal from the Engine
 * (a stale evaluation, a duplicate accept) comes back as an error the
 * session may correct by judging again; judging the same candidate twice
 * without the Engine's ask is the session's failure to avoid, not this
 * tool's to mask.
 */
export default defineTool({
  description:
    "Record the final admission decision for this evaluation, beside a calibrated probability. Call it exactly once, after orchestrator_eval recorded a judgment; do not judge again after it.",
  inputSchema: z.object({}),
  async execute(_input, ctx) {
    const resolved = await resolveAssessment(ctx.session, "orchestrator_eval_decide");
    if (!resolved.ok) return { error: resolved.error };
    return resolved.assessor.tools.decide(resolved.assessmentId);
  },
});
