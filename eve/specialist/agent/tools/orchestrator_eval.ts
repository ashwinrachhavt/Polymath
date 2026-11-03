import { defineTool } from "eve/tools";
import { z } from "zod";
import { resolveAssessment } from "../lib/assessor-bridge";

/*
 * The eval protocol's second step: record the judgment. An accept names a
 * short title and a concrete scope — the schema's required-when-accept shape
 * is enforced by the assessor itself, which answers with a precise refusal
 * the session can correct, so this tool accepts the call and relays the
 * verdict.
 */
export default defineTool({
  description:
    "Record your admission judgment for the candidate you read with orchestrator_eval_read. An accept names a short title and a concrete scope; a stop names the ticket to stop. Call it once, then finish with orchestrator_eval_decide.",
  inputSchema: z.object({
    outcome: z.enum(["accept", "ignore", "stop", "unavailable"]),
    reason: z.string().min(1).max(2000),
    rules: z.array(z.string().min(1).max(200)).max(20).optional(),
    title: z.string().min(1).max(200).optional(),
    scope: z.string().min(1).max(4000).optional(),
    name: z.string().min(1).max(200).optional(),
    note: z.string().min(1).max(4000).optional(),
    acknowledgement: z.string().min(1).max(2000).optional(),
    ticketId: z.string().min(1).max(200).optional(),
  }),
  async execute(input, ctx) {
    const resolved = await resolveAssessment(ctx.session, "orchestrator_eval");
    if (!resolved.ok) return { error: resolved.error };
    return resolved.assessor.tools.judge(resolved.assessmentId, input);
  },
});
