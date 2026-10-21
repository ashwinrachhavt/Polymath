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

/* What the OAuth callback reported, in the owner's words. */
const CONNECTION_RESULT: Record<string, string> = {
  connected: "Connected.",
  "missing-state": "The provider did not return a state token, so the connection could not be matched. Try connecting again.",
  "unknown-attempt": "That connection attempt is no longer valid. Start it again.",
  "provider-not-active": "The provider did not finish authorising the account. Try again.",
  incomplete: "That attempt never reached the provider. Start it again.",
  "not-configured": "Composio is not configured for this provider on this deployment.",
  failed: "The provider returned an error while connecting.",
  "signed-out": "You were signed out during the connection. Sign in and try again.",
};

async function Connectors({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await connection();
  const query = await searchParams;
  const connectionResult = typeof query.connection === "string" ? query.connection : null;
  const resultMessage = connectionResult ? CONNECTION_RESULT[connectionResult] ?? "The connection did not complete." : null;
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
      allowRead: account.allowRead,
      allowWrite: account.allowWrite,
      lastHealthyAt: account.lastHealthyAt ? account.lastHealthyAt.toISOString() : null,
      lastError: account.lastError,
      version: account.version,
    })),
  }));

  return (
    <Screen
      title="Connectors"
      description="External writes always require an explicit account and your approval; nothing connects or sends by default."
    >
      {resultMessage ? (
        <p
          role="status"
          className={
            connectionResult === "connected"
              ? "rounded-md border border-border bg-muted px-3 py-2 text-[13px]"
              : "rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-[13px] text-destructive"
          }
        >
          {resultMessage}
        </p>
      ) : null}

      <ConnectorCatalog connectors={catalog} />

      <Panel title="Register an account" description="Creates the bookkeeping row in a connecting state. The OAuth handshake arrives with the provider connection work; until then the row is bookkeeping only.">
        <RegisterForm providers={connectors.map((c) => ({ provider: c.provider, displayName: c.displayName }))} />
      </Panel>
    </Screen>
  );
}

export default function ConnectorsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  return (
    <Suspense fallback={<p role="status" className="p-6 text-[13px] text-muted-foreground">Opening connectors…</p>}>
      <Connectors searchParams={searchParams} />
    </Suspense>
  );
}
