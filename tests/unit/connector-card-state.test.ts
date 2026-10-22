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
    lastHealthyAt: null,
    lastError: overrides.lastError ?? null,
    version: 1,
  };
}

function connector(overrides: {
  accounts?: CatalogConnector["accounts"];
  accessTiers?: CatalogConnector["accessTiers"];
} = {}): CatalogConnector {
  return {
    provider: "gmail",
    displayName: "Gmail",
    capabilities: [],
    riskByCapability: {},
    accessTiers: [
      { id: "read_only", label: "Read only", description: "Reads mail.", capabilities: ["gmail.read"] },
    ],
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
});
