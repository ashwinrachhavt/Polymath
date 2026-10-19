import { connection } from "next/server";
import { Suspense } from "react";
import { Empty, Panel, Screen, Status } from "@/components/workspace/ui";
import { listConnectors } from "@/domains/integrations/queries";
import { getAuthContext } from "@/lib/auth";
import { AccountControls, ConnectButton, RegisterForm } from "./connector-controls";

export const metadata = { title: "Connectors · Axiom" };

/*
 * The durable connectors surface (ASH D09 foundation): the seeded catalog
 * with each provider's capability risks, plus the workspace's account rows
 * and their states. Tokens stay with Composio; these rows are Axiom's
 * bookkeeping. The OAuth redirect/callback scaffolding is the next slice -
 * "Mark connected" exercises the same state machine the callback will.
 */

async function Connectors() {
  await connection();
  const auth = await getAuthContext();
  const connectors = await listConnectors(auth);

  return (
    <Screen
      title="Connectors"
      description="What Axiom can talk to, and which accounts are wired. External writes always require an explicit account and your approval; nothing connects or sends by default."
    >
      <Panel title="Register an account" description="Creates the bookkeeping row in a connecting state. The OAuth handshake itself is scaffolding until the provider work lands.">
        <RegisterForm providers={connectors.map((c) => ({ provider: c.provider, displayName: c.displayName }))} />
      </Panel>

      <div className="grid items-start gap-6 xl:grid-cols-2">
        {connectors.map((connector) => (
          <Panel
            key={connector.provider}
            title={connector.displayName}
            description={connector.capabilities
              .map((capability) => `${capability.replaceAll("_", " ")} (${connector.riskByCapability[capability] ?? "read"})`)
              .join(" · ")}
          >
            <div className="divide-y divide-border">
              {connector.accounts.map((account) => (
                <div key={account.id} className="py-3 first:pt-0">
                  <div className="mb-1.5 flex flex-wrap items-center gap-2">
                    <p className="text-[13px] font-medium">{account.alias}</p>
                    <Status>{account.status}</Status>
                    {account.isDefaultForWrites ? <Status>write default</Status> : null}
                  </div>
                  <p className="mb-2 text-xs text-muted-foreground">
                    {account.lastHealthyAt
                      ? `Healthy ${account.lastHealthyAt.toISOString().slice(0, 16).replace("T", " ")}Z`
                      : "Never connected"}
                    {account.lastError ? ` · ${account.lastError}` : ""}
                  </p>
                  <AccountControls
                    accountId={account.id}
                    version={account.version}
                    status={account.status}
                    isDefault={account.isDefaultForWrites}
                  />
                  {account.status === "connecting" ? (
                    <div className="mt-2">
                      <ConnectButton provider={connector.provider} defaultAlias={account.alias} />
                    </div>
                  ) : null}
                </div>
              ))}
            </div>
            {!connector.accounts.length ? (
              <Empty title="No account" description={`Register a ${connector.displayName} account above to start a connection.`} />
            ) : null}
          </Panel>
        ))}
      </div>
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
