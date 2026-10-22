/*
 * The provider capability catalog: one authoritative answer to "what can this
 * capability do, and under what limit".
 *
 * Capability names exist in three vocabularies that must never drift:
 *  - the frozen policy snapshot and `DEFAULT_ALLOWED_TOOLS`, which spell the
 *    capability (`gmail.read`);
 *  - the risk table the evals read, `eve/alfred/evals/axiom-policy.ts`, which
 *    assigns it a class;
 *  - the MCP tool name a model calls (`gmail_search`).
 * This module is the single map between them. Everything downstream - the
 * gateway, the tools, the proposal path - reads it instead of restating a name.
 *
 * `kind` is the authorization shape, not the risk class:
 *  - `read` runs inside a turn and returns data;
 *  - `proposal` only ever writes an action proposal for the owner to decide.
 * There is deliberately no `write` kind. A provider write is reachable only
 * through the approved-effect executor, never from a model-driven tool call.
 *
 * The risk class is narrower than the spec's five: only `read` and
 * `external_write` have shipped capabilities. Keeping the union narrow means a
 * new class (a prepare or sensitive write) needs an explicit change here, not
 * a silently accepted string.
 *
 * `integration_catalog.risk_by_capability` remains display metadata for the
 * connect screen. Nothing gates on it.
 */

export type Provider =
  | "gmail"
  | "github"
  | "slack"
  | "linear"
  | "google-calendar"
  | "google-drive"
  | "google-docs"
  | "google-sheets";

export type CapabilitySpec = {
  provider: Provider;
  /** "read" runs inside a turn; "proposal" only ever creates a proposal. */
  kind: "read" | "proposal";
  riskClass: "read" | "external_write";
  /** MCP tool name the model calls. */
  tool: string;
};

/*
 * Gmail, GitHub and Slack ship in this slice (GitHub and Slack read-only).
 * Linear needs a POST-shaped GraphQL read the transport cannot express yet,
 * and Vercel and Notion rows are owned by later slices; leaving them out is what keeps this catalog honest
 * about what the gateway can actually route today.
 *
 * `gmail.read` and `gmail.send` are fixed names: they are in
 * `DEFAULT_ALLOWED_TOOLS` and in every frozen policy snapshot, so renaming one
 * is a migration with no benefit.
 */
export const CAPABILITIES = {
  "gmail.read": { provider: "gmail", kind: "read", riskClass: "read", tool: "gmail_search" },
  "gmail.thread.read": { provider: "gmail", kind: "read", riskClass: "read", tool: "gmail_read_thread" },
  "gmail.send": { provider: "gmail", kind: "proposal", riskClass: "external_write", tool: "gmail_send" },
  // GitHub and Slack ship reads only. Their writes would be proposals through
  // the same approved-effect executor Gmail uses, and are not wired yet.
  "github.read": { provider: "github", kind: "read", riskClass: "read", tool: "github_search" },
  "github.issue.read": { provider: "github", kind: "read", riskClass: "read", tool: "github_read_issue" },
  "slack.channels.read": { provider: "slack", kind: "read", riskClass: "read", tool: "slack_list_channels" },
  "slack.read": { provider: "slack", kind: "read", riskClass: "read", tool: "slack_read_channel" },
  "linear.read": { provider: "linear", kind: "read", riskClass: "read", tool: "linear_search_issues" },
  "linear.issue.read": { provider: "linear", kind: "read", riskClass: "read", tool: "linear_read_issue" },
  // Google cluster A: read-only list tools through the generic registry.
  "googlecalendar.events.read": { provider: "google-calendar", kind: "read", riskClass: "read", tool: "googlecalendar_list_events" },
  "googledrive.files.read": { provider: "google-drive", kind: "read", riskClass: "read", tool: "googledrive_search_files" },
  "googledocs.documents.read": { provider: "google-docs", kind: "read", riskClass: "read", tool: "googledocs_list_documents" },
  "googlesheets.sheets.read": { provider: "google-sheets", kind: "read", riskClass: "read", tool: "googlesheets_list_sheets" },
} as const satisfies Record<string, CapabilitySpec>;

export type Capability = keyof typeof CAPABILITIES;

/*
 * Tool name to capability, for dispatch. This is the inverse of the `tool`
 * field above; tests/unit/provider-capabilities.test.ts proves the two maps
 * agree, so a tool added to one and not the other fails there rather than
 * becoming an unroutable 404 at runtime.
 */
export const PROVIDER_TOOLS = {
  gmail_search: "gmail.read",
  gmail_read_thread: "gmail.thread.read",
  gmail_send: "gmail.send",
  github_search: "github.read",
  github_read_issue: "github.issue.read",
  slack_list_channels: "slack.channels.read",
  slack_read_channel: "slack.read",
  linear_search_issues: "linear.read",
  linear_read_issue: "linear.issue.read",
  googlecalendar_list_events: "googlecalendar.events.read",
  googledrive_search_files: "googledrive.files.read",
  googledocs_list_documents: "googledocs.documents.read",
  googlesheets_list_sheets: "googlesheets.sheets.read",
} as const satisfies Record<string, Capability>;

/*
 * The runtime bounds the gateway enforces. They live here, next to the
 * capabilities they bound, so a limit is reviewed with the thing it constrains
 * instead of in a settings screen.
 *
 * maxResponseBytes is a truncation point, not a rejection point: a result over
 * the bound is cut at the last complete record with an explicit marker, because
 * a truncated answer the model can see is safer than a silent empty one.
 */
export const LIMITS = {
  defaultResults: 25,
  maxResults: 100,
  maxResponseBytes: 65_536,
  callsPerRunPerProvider: 50,
  callsPerWorkspacePerMinute: 60,
  effectsPerRun: 5,
} as const;

/*
 * Per-connector access tiers. A tier's capability list is the enforcement
 * source for what an agent on that tier may do; the mirrored
 * `integration_catalog.access_tiers` JSON (seeded by migration 0229) is
 * display metadata for the connect screen. Keep the two in step —
 * tests/unit/provider-tiers.test.ts proves they have not drifted.
 *
 * Ordered lowest-first; each tier strictly extends the one below it.
 * `integration_catalog.risk_by_capability` remains display metadata only.
 */
export type AccessTier = {
  id: string;
  label: string;
  description: string;
  capabilities: Capability[];
};

export const PROVIDER_TIERS: Record<Provider, AccessTier[]> = {
  gmail: [
    {
      id: "read_only",
      label: "Read only",
      description: "Agents can search and read mail.",
      capabilities: ["gmail.read", "gmail.thread.read"],
    },
    {
      id: "read_send",
      label: "Read + send proposals",
      description: "Agents can also draft send proposals for your approval.",
      capabilities: ["gmail.read", "gmail.thread.read", "gmail.send"],
    },
  ],
  github: [
    {
      id: "read_only",
      label: "Read only",
      description: "Agents can search repositories and read issues.",
      capabilities: ["github.read", "github.issue.read"],
    },
  ],
  slack: [
    {
      id: "read_only",
      label: "Read only",
      description: "Agents can list channels and read messages.",
      capabilities: ["slack.channels.read", "slack.read"],
    },
  ],
  linear: [
    {
      id: "read_only",
      label: "Read only",
      description: "Agents can search and read issues.",
      capabilities: ["linear.read", "linear.issue.read"],
    },
  ],
  "google-calendar": [
    {
      id: "read_only",
      label: "Read only",
      description: "Agents can list upcoming events on your calendar.",
      capabilities: ["googlecalendar.events.read"],
    },
  ],
  "google-drive": [
    {
      id: "read_only",
      label: "Read only",
      description: "Agents can search the files in your Drive.",
      capabilities: ["googledrive.files.read"],
    },
  ],
  "google-docs": [
    {
      id: "read_only",
      label: "Read only",
      description: "Agents can list the documents in your Google Docs.",
      capabilities: ["googledocs.documents.read"],
    },
  ],
  "google-sheets": [
    {
      id: "read_only",
      label: "Read only",
      description: "Agents can list the spreadsheets in your Google Sheets.",
      capabilities: ["googlesheets.sheets.read"],
    },
  ],
};

/** The capabilities a tier grants; empty for an unknown tier id or provider. */
export function tierCapabilities(provider: Provider, tierId: string): Capability[] {
  return PROVIDER_TIERS[provider]?.find((tier) => tier.id === tierId)?.capabilities ?? [];
}

export function tierAllows(
  provider: Provider,
  tierId: string,
  capability: Capability,
): boolean {
  return tierCapabilities(provider, tierId).includes(capability);
}

/** The narrowest tier a provider offers, or null when it has none. */
export function lowestTierId(provider: Provider): string | null {
  return PROVIDER_TIERS[provider]?.[0]?.id ?? null;
}
