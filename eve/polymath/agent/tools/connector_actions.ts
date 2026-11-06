import { defineTool } from "eve/tools";
import { z } from "zod";
import {
  CONNECTOR_WRITES,
  listConnectorActions,
  readConnectorAction,
} from "../../../../src/domains/integrations/connector-actions";

export default defineTool({
  deferred: true,
  description:
    "Find available actions for a connector, including creates, updates and sends. Returns catalog metadata only. Search first, then request one toolSlug for its exact argument schema. Use the corresponding <provider>_action_propose gateway tool. Enabled routine actions execute directly; other changes wait in Reviews. Report its actual returned outcome.",
  inputSchema: z.object({
    provider: z.string(),
    search: z.string().max(200).optional(),
    toolSlug: z
      .string()
      .regex(/^[A-Z][A-Z0-9_]{1,150}$/)
      .optional(),
  }),
  async execute(input) {
    const spec = Object.values(CONNECTOR_WRITES).find((entry) => entry.provider === input.provider);
    if (!spec) return { ok: false, error: "Unsupported connector." };
    try {
      if (input.toolSlug)
        return { ok: true, proposalTool: spec.tool, action: await readConnectorAction(spec.toolkit, input.toolSlug) };
      const actions = await listConnectorActions(input.provider, input.search);
      return {
        ok: true,
        proposalTool: spec.tool,
        actions: actions.map(({ slug, name, description }) => ({ slug, name, description: description.slice(0, 400) })),
      };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : "Could not load connector actions." };
    }
  },
});
