import { describe, expect, it } from "vitest";
import { cardState, type CatalogConnector } from "@/app/(workspace)/command-center/integrations/connector-catalog";

/*
 * The connectors page is honest about what a card can do next. cardState is
 * the whole machine: one status per card, derived from the account rows and
 * the tier catalog — never guessed from capability jargon.
 */

const EXPIRED_ATTEMPT_MESSAGE = "That connection attempt expired. Start again.";

function account(overrides: {
  id?: string;
  alias?: string;
  status: string;
  lastError?: string | null;
}): CatalogConnector["accounts"][number] {
  return {
    id: overrides.id ?? crypto.randomUUID(),
    alias: overrides.alias ?? "work",
    status: overrides.status,
    displayName: null,
    isDefaultForWrites: false,
    allowRead: true,
    allowWrite: false,
    accessTier: null,
    disabledCapabilities: [],
    lastHealthyAt: null,
    lastError: overrides.lastError ?? null,
    version: 1,
  };
}

function connector(overrides: {
  accounts?: CatalogConnector["accounts"];
  accessTiers?: CatalogConnector["accessTiers"];
  configured?: boolean;
  missingConfig?: string[];
} = {}): CatalogConnector {
  return {
    provider: "gmail",
    displayName: "Gmail",
    capabilities: [],
    riskByCapability: {},
    accessTiers: [
      { id: "read_only", label: "Read only", description: "Reads mail.", capabilities: ["gmail.read"] },
    ],
    configured: true,
    missingConfig: [],
    accounts: [],
    ...overrides,
  };
}

describe("cardState", () => {
  it("an active account means connected, whatever else exists", () => {
    const c = connector({
      accounts: [
        account({ status: "connecting" }),
        account({ status: "active" }),
      ],
    });
    expect(cardState(c)).toBe("connected");
  });

  it("a connecting account with no active account means connecting", () => {
    const c = connector({
      accounts: [account({ status: "connecting" })],
    });
    expect(cardState(c)).toBe("connecting");
  });

  it("an error or revoked account with nothing live means action_needed", () => {
    for (const status of ["error", "expired", "revoked"]) {
      const c = connector({
        accounts: [account({ status, lastError: "Token rejected." })],
      });
      expect(cardState(c), status).toBe("action_needed");
    }
  });

  it("no accounts with tiers offered means available", () => {
    expect(cardState(connector())).toBe("available");
  });

  it("no accounts and no tiers means coming_soon", () => {
    expect(cardState(connector({ accessTiers: [] }))).toBe("coming_soon");
  });

  it("a connecting account whose attempt expired means action_needed", () => {
    const c = connector({
      accounts: [account({ status: "connecting", lastError: EXPIRED_ATTEMPT_MESSAGE })],
    });
    expect(cardState(c)).toBe("action_needed");
  });

  it("a connecting card is never shown when an active account exists", () => {
    const c = connector({
      accounts: [
        account({ status: "active" }),
        account({ status: "connecting", lastError: EXPIRED_ATTEMPT_MESSAGE }),
      ],
    });
    expect(cardState(c)).not.toBe("connecting");
  });


  it("an unconfigured deployment means needs_config, whatever the accounts say", () => {
    const c = connector({
      configured: false,
      missingConfig: ["COMPOSIO_API_KEY"],
      accounts: [account({ status: "connecting", lastError: EXPIRED_ATTEMPT_MESSAGE })],
    });
    expect(cardState(c)).toBe("needs_config");
  });

  it("unconfigured with no accounts is needs_config, not available", () => {
    expect(cardState(connector({ configured: false, missingConfig: ["COMPOSIO_AUTH_CONFIG_GMAIL"] }))).toBe(
      "needs_config",
    );
  });

  it("a tierless provider is coming_soon even when the deployment is unconfigured", () => {
    // Dropbox has no tiers: no env config could make it connectable, so the
    // card says Coming soon rather than blaming deployment setup.
    expect(
      cardState(connector({ configured: false, missingConfig: ["COMPOSIO_API_KEY"], accessTiers: [] })),
    ).toBe("coming_soon");
  });

  it("a connected account stays connected even when the deployment loses its config", () => {
    const c = connector({
      configured: false,
      missingConfig: ["COMPOSIO_API_KEY"],
      accounts: [account({ status: "active" })],
    });
    expect(cardState(c)).toBe("connected");
  });

  it("a failed attempt lands on action_needed with the real reason, not a spinner", () => {
    // failConnectionAttempt flips the account to `error` with the cause; the
    // card must surface that, never sit in connecting until the TTL sweep.
    const c = connector({
      accounts: [
        account({
          status: "error",
          lastError: "Composio link request failed (401): the deployment's COMPOSIO_API_KEY is invalid.",
        }),
      ],
    });
    expect(cardState(c)).toBe("action_needed");
  });
});
