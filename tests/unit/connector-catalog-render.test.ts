import { mkdirSync, writeFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ConnectorCatalog, type CatalogConnector } from "@/app/(workspace)/command-center/integrations/connector-catalog";
import { PROVIDER_TIERS } from "@/domains/integrations/capabilities";

/*
 * Pixel harness for the connector card changes: renders the real catalog
 * component to static markup with fixture connectors in each changed state
 * (one-click Connect, needs_config naming env vars, action_needed with the
 * real failure reason, connected with tier picker + capability switches +
 * rename, tierless Coming soon) and writes the fragment for the styled
 * screenshot harness. Not a test of behavior - the unit/e2e suites own that.
 */

vi.mock("@/app/(workspace)/command-center/integrations/actions", () => ({
  renameAccountAction: vi.fn(),
  revokeAccountAction: vi.fn(),
  setAccountAccessTierAction: vi.fn(),
  setAccountCapabilityAction: vi.fn(),
  setWriteDefaultAction: vi.fn(),
  startConnectionAction: vi.fn(),
  setSenderProposalsAction: vi.fn(),
  syncGoogleCalendarAction: vi.fn(),
  syncNotionAction: vi.fn(),
}));

const account = (over: Partial<CatalogConnector["accounts"][number]> = {}) => ({
  id: "acc-1",
  alias: "work-gmail",
  status: "active",
  displayName: "ashwin@example.com",
  isDefaultForWrites: true,
  allowRead: true,
  allowWrite: true,
  accessTier: "read_send",
  disabledCapabilities: ["gmail.send"],
  lastHealthyAt: null,
  lastError: null,
  version: 3,
  senderProposalsEnabled: false,
  ...over,
});

const base = (over: Partial<CatalogConnector>): CatalogConnector => ({
  provider: "gmail",
  displayName: "Gmail",
  capabilities: [],
  riskByCapability: {},
  accessTiers: PROVIDER_TIERS.gmail,
  configured: true,
  missingConfig: [],
  accounts: [],
  ...over,
});

const fixtures: CatalogConnector[] = [
  // Connected gmail with the sender-suggestions pass ON, plus a second,
  // disconnected account where the pass is still on: the row must stay
  // visible there, read paused, and offer the stop.
  base({
    accounts: [
      account({ senderProposalsEnabled: true }),
      account({ id: "acc-2", alias: "old-gmail", status: "revoked", version: 1, senderProposalsEnabled: true }),
      account({ id: "acc-3", alias: "read-off-gmail", allowRead: false, senderProposalsEnabled: false }),
    ],
  }),
  base({ provider: "slack", displayName: "Slack", accessTiers: PROVIDER_TIERS.slack }),
  base({
    provider: "notion",
    displayName: "Notion",
    configured: false,
    missingConfig: ["COMPOSIO_AUTH_CONFIG_NOTION"],
  }),
  base({
    provider: "google-calendar",
    displayName: "Google Calendar",
    accessTiers: PROVIDER_TIERS["google-calendar"],
    accounts: [
      account({
        alias: "calendar",
        status: "failed",
        accessTier: "read_only",
        disabledCapabilities: [],
        lastError: "Composio refused the connect link: Invalid API key (401).",
      }),
    ],
  }),
  base({ provider: "dropbox", displayName: "Dropbox", configured: false, accessTiers: [] }),
  base({ provider: "linkedin", displayName: "LinkedIn", accessTiers: PROVIDER_TIERS.linkedin }),
  base({
    provider: "instagram",
    displayName: "Instagram",
    accessTiers: PROVIDER_TIERS.instagram,
    accounts: [
      account({
        alias: "work-ig",
        isDefaultForWrites: false,
        accessTier: "read_only",
        disabledCapabilities: [],
      }),
    ],
  }),
];

describe("connector catalog pixel harness", () => {
  it("renders every changed card state to static markup", () => {
    const html = renderToStaticMarkup(createElement(ConnectorCatalog, { connectors: fixtures }));
    expect(html).toContain("work-gmail");
    expect(html).toContain("No health check yet");
    // gmail.send is switched off on the fixture account, so the Send switch
    // reads off while Read stays on; the old tier select and "Narrowed by"
    // copy are gone.
    expect(html).toContain('aria-checked="false" aria-label="Send"');
    expect(html).toContain('aria-checked="true" aria-label="Read"');
    expect(html).not.toContain("Narrowed by the switches below");
    expect(html).not.toContain("Agent access");
    expect(html).toContain("Setup needed");
    // Sender-suggestions states: on for the active account, paused-but-stoppable
    // on the disconnected one, and gated with the reason on the read-off one.
    expect(html).toContain("Suggest contacts from new senders");
    expect(html).toContain("On, but not running");
    expect(html).toContain("old-gmail is disconnected");
    expect(html).toContain("Turn on read access for read-off-gmail to turn this on.");
    expect(html).toContain("Coming soon");
    expect(html).toContain("Invalid API key (401)");
    // instagram's active, non-default account must NOT offer a write default:
    // the provider has no write capability, so the control would be a lie.
    expect(html).not.toContain("Make write default");
    mkdirSync("/tmp/harness", { recursive: true });
    writeFileSync("/tmp/harness/fragment.html", html);
  });
});
