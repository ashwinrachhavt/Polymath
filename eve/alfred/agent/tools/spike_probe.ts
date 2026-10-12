// Spike tool: proves `defineTool` + the approval policy surface. Throwaway.
// `always()` is a pure function returning an ApprovalPolicy — no model call.
import { always } from "eve/tools/approval";
import { defineTool } from "eve/tools";
import { z } from "zod";

export default defineTool({
  description: "Spike probe. Echoes its input after approval.",
  inputSchema: z.object({ note: z.string() }),
  approval: always(),
  async execute(input) {
    return { echoed: input.note };
  },
});
