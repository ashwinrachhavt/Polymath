import { describe, expect, it } from "vitest";
import { connectorConfigState } from "@/domains/integrations/queries";

/*
 * The catalog's honest gate is the Composio project key alone. Auth config
 * ids are discovered from the Composio API at link time (see composio.ts) —
 * a per-provider COMPOSIO_AUTH_CONFIG_<PROVIDER> var is only ever a manual
 * override, so its absence must never read as "Setup needed".
 */

describe("connectorConfigState", () => {
  it("does not demand per-provider auth config env vars", () => {
    const state = connectorConfigState({ composioApiKey: "k", providerEnv: {} });
    expect(state.configured).toBe(true);
    expect(state.missingConfig).toEqual([]);
  });

  it("reports only the missing project key", () => {
    const state = connectorConfigState({ composioApiKey: undefined, providerEnv: {} });
    expect(state.configured).toBe(false);
    expect(state.missingConfig).toEqual(["COMPOSIO_API_KEY"]);
  });

  it("treats an empty project key as missing", () => {
    const state = connectorConfigState({ composioApiKey: "", providerEnv: {} });
    expect(state.configured).toBe(false);
    expect(state.missingConfig).toEqual(["COMPOSIO_API_KEY"]);
  });
});
