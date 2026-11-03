import { defineTool } from "eve/tools";
import { z } from "zod";
import { resolveAssessment } from "../lib/assessor-bridge";

/*
 * The eval protocol's first step: read the bounded candidate. Everything the
 * judge is allowed to see comes back from this tool — there is nothing more
 * to read, so the session never asks the wider agent for context.
 */
export default defineTool({
  description:
    "Read the bounded candidate this admission evaluation judges. Call it first, with each part you need (thread, triggers, tickets, rules); everything it returns is bounded, and there is nothing more to read about the candidate.",
  inputSchema: z.object({
    part: z.enum(["thread", "triggers", "tickets", "rules"]),
  }),
  async execute(input, ctx) {
    const resolved = await resolveAssessment(ctx.session, "orchestrator_eval_read");
    if (!resolved.ok) return { error: resolved.error };
    return resolved.assessor.tools.read(resolved.assessmentId, input.part);
  },
});
