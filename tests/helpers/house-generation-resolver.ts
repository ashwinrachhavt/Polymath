import { vi } from "vitest";
import { generationProvider } from "@/integrations/generation/provider";

/*
 * For unit tests of a generation adapter's wiring: the billing resolver is
 * replaced by the house chain it falls through to, so no database is needed to
 * prove which provider an environment selects. The resolver's own behaviour
 * (own key, allowance, ledger) is proven in tests/integration/billing.test.ts.
 */
export async function houseGenerationResolver() {
  const original = await vi.importActual<typeof import("@/domains/billing/resolver")>("@/domains/billing/resolver");
  return {
    ...original,
    resolveGeneration: async (
      _workspaceId: string,
      _purpose: string,
      deps: { env?: Record<string, string | undefined>; fetchImpl?: typeof fetch } = {},
    ) => generationProvider(deps.env, deps.fetchImpl),
  };
}
