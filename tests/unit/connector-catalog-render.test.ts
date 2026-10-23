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
  base({ accounts: [account()] }),
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
];

describe("connector catalog pixel harness", () => {
  it("renders every changed card state to static markup", () => {
    const html = renderToStaticMarkup(createElement(ConnectorCatalog, { connectors: fixtures }));
    expect(html).toContain("work-gmail");
    expect(html).toContain("Setup needed");
    expect(html).toContain("Coming soon");
    expect(html).toContain("Invalid API key (401)");
    mkdirSync("/tmp/harness", { recursive: true });
    writeFileSync("/tmp/harness/fragment.html", html);
  });
});
