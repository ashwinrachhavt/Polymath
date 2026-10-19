import { connection } from "next/server";
import { Suspense } from "react";
import { Panel, Screen } from "@/components/workspace/ui";
import { listConnectors } from "@/domains/integrations/queries";
import { getAuthContext } from "@/lib/auth";
import { ConnectorCatalog, type CatalogConnector } from "./connector-catalog";
import { RegisterForm } from "./connector-controls";

export const metadata = { title: "Connectors · Polymath" };

/*
 * The durable connectors surface (ASH D09 foundation): the seeded catalog
 * with each provider's capability risks, plus the workspace's account rows
 * and their states. Tokens stay with Composio; these rows are Polymath's
 * bookkeeping. Layout follows the dark catalog reference: search, an
 * All / Connected / Available filter, and category groups of quiet cards.
 */

async function Connectors() {
  await connection();
  const auth = await getAuthContext();
  const connectors = await listConnectors(auth);

  const catalog: CatalogConnector[] = connectors.map((connector) => ({
    provider: connector.provider,
    displayName: connector.displayName,
    capabilities: connector.capabilities,
    riskByCapability: connector.riskByCapability,
    accounts: connector.accounts.map((account) => ({
      id: account.id,
      alias: account.alias,
      status: account.status,
      displayName: account.displayName,
      isDefaultForWrites: account.isDefaultForWrites,
      lastHealthyAt: account.lastHealthyAt ? account.lastHealthyAt.toISOString() : null,
      lastError: account.lastError,
      version: account.version,
    })),
  }));

  return (
    <Screen
      title="Connectors"
      description="What Polymath can talk to, and which accounts are wired. External writes always require an explicit account and your approval; nothing connects or sends by default."
    >
      <ConnectorCatalog connectors={catalog} />

      <Panel title="Register an account" description="Creates the bookkeeping row in a connecting state. The OAuth handshake arrives with the provider connection work; until then the row is bookkeeping only.">
        <RegisterForm providers={connectors.map((c) => ({ provider: c.provider, displayName: c.displayName }))} />
      </Panel>
    </Screen>
  );
}

export default function ConnectorsPage() {
  return (
    <Suspense fallback={<p role="status" className="p-6 text-[13px] text-muted-foreground">Opening connectors…</p>}>
      <Connectors />
    </Suspense>
  );
}
