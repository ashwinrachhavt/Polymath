import { defineTool } from "eve/tools";
import { z } from "zod";
import { toolAllowed } from "../lib/policy";
// Relative, not "@/...": eve bundles this agent from its own package root and
// does not carry the app's tsconfig paths (see hooks/bridge.ts).
import { getRunBySessionRef } from "../../../../src/domains/agents/queries";
import { executeComposioRead } from "../../../../src/domains/integrations/composio";
import { resolveConnectedAccount } from "../../../../src/domains/integrations/queries";

/*
 * A read against a connected third-party service, through Composio.
 *
 * This is the only place an agent reaches a provider inline. Everything about it
 * is narrower than a general HTTP client:
 *  - the account comes from the workspace's own connected accounts, found by
 *    alias; the model never sees a Composio id or a token;
 *  - only GET/HEAD reach the provider — executeComposioRead throws on anything
 *    else, so a model cannot turn a read capability into a write;
 *  - the run's frozen policy must allow `<provider>.read`, checked here and not
 *    inferred from the tool being visible;
 *  - the endpoint must be an absolute https URL on an allowlisted host, so a
 *    prompt cannot aim the owner's connected account at an arbitrary server.
 *
 * Writes are not this tool's job: gmail_send and calendar_propose record an
 * action_proposal, and the owner decides.
 */

/**
 * Provider to (catalog id, Composio toolkit slug, capability).
 *
 * The three names are genuinely different and all three matter:
 *  - the catalog id is what `integration_catalog.provider` and
 *    `external_accounts.provider` hold, registered through `registerAccount`,
 *    which rejects anything not in the catalog ("google-calendar", hyphenated);
 *  - the Composio toolkit slug is what their API calls it ("googlecalendar",
 *    no hyphen — verified against GET /v3.1/toolkits);
 *  - the capability is a key in the risk table
 *    (eve/alfred/evals/axiom-policy.ts); a capability absent from that table
 *    has no risk class and can never be granted.
 *
 * The tool's input enum uses the catalog id, because that is what the owner sees
 * on the connectors screen and what the account row is keyed by.
 */
const PROVIDERS: Readonly<Record<string, { catalog: string; toolkit: string; capability: string; hosts: readonly string[] }>> = {
  gmail: {
    catalog: "gmail",
    toolkit: "gmail",
    capability: "gmail.read",
    hosts: ["gmail.googleapis.com"],
  },
  "google-calendar": {
    catalog: "google-calendar",
    toolkit: "googlecalendar",
    capability: "calendar.read",
    hosts: ["www.googleapis.com"],
  },
  notion: {
    catalog: "notion",
    toolkit: "notion",
    capability: "notion.read",
    hosts: ["api.notion.com"],
  },
};

/** Exported for the capability-coverage test: every value must be in the risk table. */
export const AVAILABLE_READ_TOOL = Object.fromEntries(
  Object.entries(PROVIDERS).map(([provider, spec]) => [provider, spec.capability]),
) as Readonly<Record<string, string>>;

export default defineTool({
  description:
    "Read data from a connected service (Gmail, Google Calendar, Notion) through the owner's account. Read-only: it cannot send, create, or delete. The run's frozen policy must allow <provider>.read.",
  inputSchema: z.object({
    provider: z
      .enum(["gmail", "google-calendar", "notion"])
      .describe("Which connected service to read."),
    url: z.string().url().describe("Absolute https URL of the provider API resource to read."),
    accountAlias: z
      .string()
      .optional()
      .describe("Which connected account, e.g. work-gmail. Required when more than one is connected."),
    query: z.record(z.string(), z.string()).optional().describe("Query-string parameters."),
    headers: z.record(z.string(), z.string()).optional().describe("Additional request headers the API requires."),
  }),
  async execute(input, ctx) {
    // The host allowlist is the guard against a prompt aiming this account
    // somewhere else. It runs before any database or account lookup: an
    // off-host URL should cost nothing and reveal nothing.
    let parsed: URL;
    try {
      parsed = new URL(input.url);
    } catch {
      return { ok: false as const, error: "url is not a valid URL" };
    }
    const spec = PROVIDERS[input.provider];
    if (!spec) return { ok: false as const, error: `unknown provider ${input.provider}` };
    const allowed = spec.hosts;
    if (parsed.protocol !== "https:" || !allowed.includes(parsed.hostname)) {
      return {
        ok: false as const,
        error: `${input.provider} reads must target https on ${allowed.join(" or ")}`,
      };
    }

    const current = ctx.session.auth.current;
    const workspaceId = current?.attributes?.workspaceId;
    if (typeof workspaceId !== "string" || !current?.principalId) {
      return { ok: false as const, error: "no workspace in session" };
    }

    const run = await getRunBySessionRef(ctx.session.id, workspaceId);
    if (!run || run.state !== "running") {
      return { ok: false as const, error: "no active Polymath run bound to this session" };
    }
    const capability = spec.capability;
    if (!toolAllowed(run.policySnapshot, capability)) {
      return { ok: false as const, error: `${capability} is not in this run's policy snapshot` };
    }

    // The account row is keyed by the catalog id, not the Composio slug.
    const account = await resolveConnectedAccount(
      { userId: current.principalId, workspaceId, role: "viewer" },
      spec.catalog,
      input.accountAlias,
    );
    if (!account.ok) return { ok: false as const, error: account.message };

    const result = await executeComposioRead({
      connectedAccountId: account.connectedAccountId,
      endpoint: parsed.toString(),
      method: "GET",
      query: input.query,
      headers: input.headers,
    });
    if (!result.ok) return { ok: false as const, error: result.message };
    return { ok: true as const, provider: input.provider, account: account.alias, data: result.data };
  },
});
