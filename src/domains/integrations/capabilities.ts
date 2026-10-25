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
  | "google-sheets"
  | "discord"
  | "zoom"
  | "calendly"
  | "asana"
  | "trello"
  | "airtable"
  | "canva"
  | "hubspot"
  | "stripe"
  | "notion"
  | "linkedin"
  | "instagram";

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
 * Providers whose reads the transport cannot express yet stay out of this
 * catalog: that is what keeps it honest about what the gateway can actually
 * route today.
 *
 * Notion ships as a search + page read through the constant-body POST seam
 * (the transport's second exception, after GraphQL: the provider module owns
 * the endpoint and body shape; only validated values travel).
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
  // Docs and Sheets list through Drive's files endpoint filtered by mimeType,
  // which the same generic read expresses — the 0230 comment claiming they
  // had no GET list API was wrong.
  "googlecalendar.events.read": { provider: "google-calendar", kind: "read", riskClass: "read", tool: "googlecalendar_list_events" },
  "googledrive.files.read": { provider: "google-drive", kind: "read", riskClass: "read", tool: "googledrive_search_files" },
  "googledocs.documents.read": { provider: "google-docs", kind: "read", riskClass: "read", tool: "googledocs_search_files" },
  "googlesheets.spreadsheets.read": { provider: "google-sheets", kind: "read", riskClass: "read", tool: "googlesheets_list_spreadsheets" },
  // Comms and meetings cluster B: read-only lists through the generic registry.
  "discord.guilds.read": { provider: "discord", kind: "read", riskClass: "read", tool: "discord_list_channels" },
  "zoom.meetings.read": { provider: "zoom", kind: "read", riskClass: "read", tool: "zoom_list_meetings" },
  "calendly.events.read": { provider: "calendly", kind: "read", riskClass: "read", tool: "calendly_list_events" },
  // Work-management cluster C: read-only lists through the generic registry.
  // Jira's host is per-site and nothing resolves it statically yet, so its
  // tool waits for a slice that can.
  "asana.tasks.read": { provider: "asana", kind: "read", riskClass: "read", tool: "asana_list_tasks" },
  "trello.cards.read": { provider: "trello", kind: "read", riskClass: "read", tool: "trello_list_cards" },
  "airtable.bases.read": { provider: "airtable", kind: "read", riskClass: "read", tool: "airtable_list_records" },
  // Design, CRM and finance cluster D: read-only lists through the generic
  // registry. Figma (files list needs a project id), Dropbox (list_folder is
  // POST-shaped) and Salesforce (per-org host, unresolvable statically) have
  // no GET-expressible list and stay absent.
  "canva.designs.read": { provider: "canva", kind: "read", riskClass: "read", tool: "canva_list_designs" },
  "hubspot.contacts.read": { provider: "hubspot", kind: "read", riskClass: "read", tool: "hubspot_list_contacts" },
  "stripe.payments.read": { provider: "stripe", kind: "read", riskClass: "read", tool: "stripe_list_payments" },
  "notion.read": { provider: "notion", kind: "read", riskClass: "read", tool: "notion_search" },
  "notion.page.read": { provider: "notion", kind: "read", riskClass: "read", tool: "notion_read_page" },
  // Social profiles: identity reads only. LinkedIn's member-feed read is a
  // restricted permission; Instagram media reads need a professional account.
  // Neither provider's writes are wired.
  "linkedin.profile.read": { provider: "linkedin", kind: "read", riskClass: "read", tool: "linkedin_get_profile" },
  "instagram.profile.read": { provider: "instagram", kind: "read", riskClass: "read", tool: "instagram_get_profile" },
  "instagram.media.read": { provider: "instagram", kind: "read", riskClass: "read", tool: "instagram_list_media" },
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
  googledocs_search_files: "googledocs.documents.read",
  googlesheets_list_spreadsheets: "googlesheets.spreadsheets.read",
  discord_list_channels: "discord.guilds.read",
  zoom_list_meetings: "zoom.meetings.read",
  calendly_list_events: "calendly.events.read",
  asana_list_tasks: "asana.tasks.read",
  trello_list_cards: "trello.cards.read",
  airtable_list_records: "airtable.bases.read",
  canva_list_designs: "canva.designs.read",
  hubspot_list_contacts: "hubspot.contacts.read",
  stripe_list_payments: "stripe.payments.read",
  notion_search: "notion.read",
  notion_read_page: "notion.page.read",
  linkedin_get_profile: "linkedin.profile.read",
  instagram_get_profile: "instagram.profile.read",
  instagram_list_media: "instagram.media.read",
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
 * `integration_catalog.access_tiers` JSON (seeded by migration 0229 and the
 * cluster migrations) is display metadata for the connect screen. Keep the two
 * in step — tests/unit/provider-tiers.test.ts proves they have not drifted.
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
      description: "Agents can search your Google Docs.",
      capabilities: ["googledocs.documents.read"],
    },
  ],
  "google-sheets": [
    {
      id: "read_only",
      label: "Read only",
      description: "Agents can list your Google Sheets spreadsheets.",
      capabilities: ["googlesheets.spreadsheets.read"],
    },
  ],
  discord: [
    {
      id: "read_only",
      label: "Read only",
      description: "Agents can list the Discord servers your connection can see.",
      capabilities: ["discord.guilds.read"],
    },
  ],
  zoom: [
    {
      id: "read_only",
      label: "Read only",
      description: "Agents can list your scheduled Zoom meetings.",
      capabilities: ["zoom.meetings.read"],
    },
  ],
  calendly: [
    {
      id: "read_only",
      label: "Read only",
      description: "Agents can list your scheduled Calendly events.",
      capabilities: ["calendly.events.read"],
    },
  ],
  asana: [
    {
      id: "read_only",
      label: "Read only",
      description: "Agents can list the tasks assigned to you in Asana.",
      capabilities: ["asana.tasks.read"],
    },
  ],
  trello: [
    {
      id: "read_only",
      label: "Read only",
      description: "Agents can list the Trello cards on your boards.",
      capabilities: ["trello.cards.read"],
    },
  ],
  airtable: [
    {
      id: "read_only",
      label: "Read only",
      description: "Agents can list the bases in your Airtable workspace.",
      capabilities: ["airtable.bases.read"],
    },
  ],
  canva: [
    {
      id: "read_only",
      label: "Read only",
      description: "Agents can list your Canva designs.",
      capabilities: ["canva.designs.read"],
    },
  ],
  hubspot: [
    {
      id: "read_only",
      label: "Read only",
      description: "Agents can list the contacts in your HubSpot CRM.",
      capabilities: ["hubspot.contacts.read"],
    },
  ],
  stripe: [
    {
      id: "read_only",
      label: "Read only",
      description:
        "Agents can list payments and charges. Read-only; charges are never agent-proposed in this tier.",
      capabilities: ["stripe.payments.read"],
    },
  ],
  notion: [
    {
      id: "read_only",
      label: "Read only",
      description: "Agents can search and read the pages and databases you share with the connection.",
      capabilities: ["notion.read", "notion.page.read"],
    },
  ],
  linkedin: [
    {
      id: "read_only",
      label: "Read only",
      description: "Agents can read your LinkedIn profile name, headline and photo.",
      capabilities: ["linkedin.profile.read"],
    },
  ],
  instagram: [
    {
      id: "read_only",
      label: "Read only",
      description: "Agents can read your Instagram profile and recent media. Needs a Business or Creator account.",
      capabilities: ["instagram.profile.read", "instagram.media.read"],
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

/*
 * Plain-language capability names for the connect screen's per-account
 * switches. The capability id stays the contract in the gateway, the policy
 * snapshot and the evals; this label is only what a person reads while
 * deciding what one account may do.
 */
export const CAPABILITY_LABELS: Record<Capability, string> = {
  "gmail.read": "Search mail",
  "gmail.thread.read": "Read threads",
  "gmail.send": "Prepare send proposals",
  "github.read": "Search repositories",
  "github.issue.read": "Read issues",
  "slack.channels.read": "List channels",
  "slack.read": "Read messages",
  "linear.read": "Search issues",
  "linear.issue.read": "Read issues",
  "googlecalendar.events.read": "List events",
  "googledrive.files.read": "Search files",
  "googledocs.documents.read": "Search documents",
  "googlesheets.spreadsheets.read": "List spreadsheets",
  "discord.guilds.read": "List servers",
  "zoom.meetings.read": "List meetings",
  "calendly.events.read": "List scheduled events",
  "asana.tasks.read": "List tasks",
  "trello.cards.read": "List cards",
  "airtable.bases.read": "List records",
  "canva.designs.read": "List designs",
  "hubspot.contacts.read": "List contacts",
  "stripe.payments.read": "List payments",
  "notion.read": "Search pages",
  "notion.page.read": "Read pages",
  "linkedin.profile.read": "Read profile",
  "instagram.profile.read": "Read profile",
  "instagram.media.read": "Read recent media",
};

/*
 * What one account actually grants: the tier's capabilities minus the ones
 * the owner switched off on that account. The tier stays the ceiling — a
 * switch can only ever narrow it, never grant above it.
 */
export function effectiveCapabilities(
  provider: Provider,
  tierId: string,
  disabled: readonly string[],
): Capability[] {
  const off = new Set(disabled);
  return tierCapabilities(provider, tierId).filter((capability) => !off.has(capability));
}

/** The live per-call check: inside the tier and not switched off on the account. */
export function capabilityAllowed(
  provider: Provider,
  tierId: string,
  disabled: readonly string[],
  capability: Capability,
): boolean {
  return tierAllows(provider, tierId, capability) && !disabled.includes(capability);
}
