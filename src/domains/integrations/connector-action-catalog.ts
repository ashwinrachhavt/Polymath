import type { CapabilitySpec } from "./capabilities";

/** Actions are granted per provider; only the explicit routine list runs directly. */
export const CONNECTOR_WRITES = {
  "gmail.actions.write": {
    provider: "gmail",
    toolkit: "gmail",
    tool: "gmail_action_propose",
    kind: "proposal",
    riskClass: "external_write",
  },
  "github.actions.write": {
    provider: "github",
    toolkit: "github",
    tool: "github_action_propose",
    kind: "proposal",
    riskClass: "external_write",
  },
  "slack.actions.write": {
    provider: "slack",
    toolkit: "slack",
    tool: "slack_action_propose",
    kind: "proposal",
    riskClass: "external_write",
  },
  "linear.actions.write": {
    provider: "linear",
    toolkit: "linear",
    tool: "linear_action_propose",
    kind: "proposal",
    riskClass: "external_write",
  },
  "googlecalendar.actions.write": {
    provider: "google-calendar",
    toolkit: "googlecalendar",
    tool: "googlecalendar_action_propose",
    kind: "proposal",
    riskClass: "external_write",
  },
  "googledrive.actions.write": {
    provider: "google-drive",
    toolkit: "googledrive",
    tool: "googledrive_action_propose",
    kind: "proposal",
    riskClass: "external_write",
  },
  "googledocs.actions.write": {
    provider: "google-docs",
    toolkit: "googledocs",
    tool: "googledocs_action_propose",
    kind: "proposal",
    riskClass: "external_write",
  },
  "googlesheets.actions.write": {
    provider: "google-sheets",
    toolkit: "googlesheets",
    tool: "googlesheets_action_propose",
    kind: "proposal",
    riskClass: "external_write",
  },
  "discord.actions.write": {
    provider: "discord",
    toolkit: "discord",
    tool: "discord_action_propose",
    kind: "proposal",
    riskClass: "external_write",
  },
  "zoom.actions.write": {
    provider: "zoom",
    toolkit: "zoom",
    tool: "zoom_action_propose",
    kind: "proposal",
    riskClass: "external_write",
  },
  "calendly.actions.write": {
    provider: "calendly",
    toolkit: "calendly",
    tool: "calendly_action_propose",
    kind: "proposal",
    riskClass: "external_write",
  },
  "asana.actions.write": {
    provider: "asana",
    toolkit: "asana",
    tool: "asana_action_propose",
    kind: "proposal",
    riskClass: "external_write",
  },
  "trello.actions.write": {
    provider: "trello",
    toolkit: "trello",
    tool: "trello_action_propose",
    kind: "proposal",
    riskClass: "external_write",
  },
  "airtable.actions.write": {
    provider: "airtable",
    toolkit: "airtable",
    tool: "airtable_action_propose",
    kind: "proposal",
    riskClass: "external_write",
  },
  "canva.actions.write": {
    provider: "canva",
    toolkit: "canva",
    tool: "canva_action_propose",
    kind: "proposal",
    riskClass: "external_write",
  },
  "hubspot.actions.write": {
    provider: "hubspot",
    toolkit: "hubspot",
    tool: "hubspot_action_propose",
    kind: "proposal",
    riskClass: "external_write",
  },
  "stripe.actions.write": {
    provider: "stripe",
    toolkit: "stripe",
    tool: "stripe_action_propose",
    kind: "proposal",
    riskClass: "external_write",
  },
  "notion.actions.write": {
    provider: "notion",
    toolkit: "notion",
    tool: "notion_action_propose",
    kind: "proposal",
    riskClass: "external_write",
  },
  "linkedin.actions.write": {
    provider: "linkedin",
    toolkit: "linkedin",
    tool: "linkedin_action_propose",
    kind: "proposal",
    riskClass: "external_write",
  },
  "instagram.actions.write": {
    provider: "instagram",
    toolkit: "instagram",
    tool: "instagram_action_propose",
    kind: "proposal",
    riskClass: "external_write",
  },
} as const satisfies Record<string, CapabilitySpec & { toolkit: string }>;
/** Create-only personal/work records. No deletes, permissions, money, or publishing. */
const ROUTINE_ACTIONS = new Set([
  "GMAIL_CREATE_EMAIL_DRAFT",
  "GMAIL_CREATE_LABEL",
  "GITHUB_CREATE_AN_ISSUE",
  "GITHUB_CREATE_A_LABEL",
  "GITHUB_CREATE_A_MILESTONE",
  "GITHUB_ADD_LABELS_TO_AN_ISSUE",
  "SLACK_CREATE_A_REMINDER",
  "SLACK_CREATE_SLACK_LIST_ITEM",
  "LINEAR_CREATE_LINEAR_ISSUE",
  "LINEAR_CREATE_LINEAR_LABEL",
  "LINEAR_CREATE_PROJECT_MILESTONE",
  "GOOGLEDRIVE_CREATE_FOLDER",
  "GOOGLEDRIVE_CREATE_FILE_FROM_TEXT",
  "GOOGLEDRIVE_CREATE_SHORTCUT_TO_FILE",
  "GOOGLEDOCS_CREATE_DOCUMENT",
  "GOOGLEDOCS_CREATE_DOCUMENT_MARKDOWN",
  "GOOGLEDOCS_COPY_DOCUMENT",
  "GOOGLESHEETS_CREATE_GOOGLE_SHEET1",
  "ZOOM_CREATE_WHITEBOARD",
  "CALENDLY_CREATE_SINGLE_USE_SCHEDULING_LINK",
  "ASANA_CREATE_A_TASK",
  "ASANA_CREATE_SUBTASK",
  "ASANA_CREATE_A_TAG_IN_A_WORKSPACE",
  "CANVA_POST_DESIGNS",
  "CANVA_POST_FOLDERS",
  "HUBSPOT_CREATE_CONTACT",
  "HUBSPOT_CREATE_COMPANY",
]);
export function isRoutineConnectorAction(toolSlug: string): boolean {
  return ROUTINE_ACTIONS.has(toolSlug);
}

export type ConnectorWriteCapability = keyof typeof CONNECTOR_WRITES;
export function connectorWrite(capability: string) {
  return Object.entries(CONNECTOR_WRITES).find(([key]) => key === capability)?.[1];
}
export function connectorWriteForTool(tool: string) {
  return Object.values(CONNECTOR_WRITES).find((entry) => entry.tool === tool);
}
export const CONNECTOR_TOOL_CAPABILITIES = Object.fromEntries(
  Object.entries(CONNECTOR_WRITES).map(([capability, spec]) => [spec.tool, capability]),
) as { [C in ConnectorWriteCapability as (typeof CONNECTOR_WRITES)[C]["tool"]]: C };
export type ConnectorActionTool = keyof typeof CONNECTOR_TOOL_CAPABILITIES;
export const CONNECTOR_TOOL_DESCRIPTIONS = Object.fromEntries(
  Object.values(CONNECTOR_WRITES).map((spec) => [
    spec.tool,
    `Act in ${spec.provider} when Write is enabled. Routine record creation runs directly; consequential actions wait in Reviews. Find the toolSlug and schema with connector_actions first. Report the returned status exactly.`,
  ]),
) as Record<ConnectorActionTool, string>;
export const CONNECTOR_ACCOUNT_PROVIDERS = Object.fromEntries(
  Object.entries(CONNECTOR_WRITES).map(([capability, spec]) => [capability, spec.provider]),
);
