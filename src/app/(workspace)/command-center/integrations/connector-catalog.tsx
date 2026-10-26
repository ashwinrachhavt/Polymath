"use client";

import { useMemo, useState } from "react";
import { Empty, SearchField, Status } from "@/components/workspace/ui";
import { ProviderIcon } from "@/components/chat/provider-icon";
import { cn } from "cn";
import { AccessToggles, AccountControls, ConnectButton, SenderGrantControls, SenderProposalsRow } from "./connector-controls";
import { senderProposalsBlockedReason } from "@/domains/crm/sender-proposals-gate";

/*
 * One card per provider, and the card says what the person can do next.
 * cardState derives the single state a card can be in from the account rows
 * and the tier catalog; the body renders from that state, so a card never
 * shows a control its state cannot honor.
 */

export type CatalogAccount = {
  id: string;
  alias: string;
  status: string;
  senderProposalsEnabled: boolean;
  displayName: string | null;
  isDefaultForWrites: boolean;
  allowRead: boolean;
  allowWrite: boolean;
  accessTier: string | null;
  disabledCapabilities: string[];
  lastHealthyAt: string | null;
  lastError: string | null;
  version: number;
};

export type CatalogConnector = {
  provider: string;
  displayName: string;
  capabilities: string[];
  riskByCapability: Record<string, string>;
  accessTiers: Array<{ id: string; label: string; description: string; capabilities: string[] }>;
  configured: boolean;
  missingConfig: string[];
  accounts: CatalogAccount[];
};

export type CardState = "needs_config" | "coming_soon" | "available" | "connecting" | "connected" | "action_needed";

/*
 * Instant providers (spec #316): their catalog capabilities are the derived
 * instant.* names, and no connection is ever created for them — the card
 * offers nothing to connect because there is nothing to connect.
 */
export function isInstantConnector(connector: CatalogConnector): boolean {
  return connector.capabilities.some((capability) => capability.startsWith("instant."));
}

/* connect.ts expires a pending attempt with this message; the card reads it. */
const EXPIRED_ATTEMPT_MESSAGE = "That connection attempt expired. Start again.";

export function cardState(connector: CatalogConnector): CardState {
  if (connector.accounts.some((account) => account.status === "active")) return "connected";
  // A provider with no agent-action tiers is not connectable on any
  // deployment, whatever its env says — Coming soon wins over Setup needed.
  if (!connector.accessTiers.length) return "coming_soon";
  // An unconfigured deployment cannot complete any handshake, so nothing on
  // the card may offer Connect — not even to resume a half-open attempt.
  if (!connector.configured) return "needs_config";
  const live = connector.accounts.filter((account) => account.status === "connecting");
  if (
    live.some(
      (account) =>
        account.lastError &&
        (account.lastError === EXPIRED_ATTEMPT_MESSAGE || account.lastError.includes("not configured")),
    )
  ) {
    return "action_needed";
  }
  if (live.length) return "connecting";
  if (connector.accounts.some((account) => account.status !== "available")) return "action_needed";
  return "available";
}

const CATEGORY_BY_PROVIDER: Record<string, string> = {
  gmail: "Communication",
  slack: "Communication",
  discord: "Communication",
  "microsoft-teams": "Communication",
  whatsapp: "Communication",
  "google-calendar": "Planning",
  linear: "Planning",
  jira: "Planning",
  asana: "Planning",
  trello: "Planning",
  calendly: "Meetings",
  zoom: "Meetings",
  notion: "Knowledge",
  confluence: "Knowledge",
  "google-docs": "Documents",
  "google-sheets": "Documents",
  "google-drive": "Storage",
  dropbox: "Storage",
  "one-drive": "Storage",
  github: "Developer",
  gitlab: "Developer",
  hubspot: "Finance",
  salesforce: "Finance",
  stripe: "Finance",
  figma: "Design",
  canva: "Design",
};

const STATE_LABEL: Record<CardState, string> = {
  needs_config: "Setup needed",
  coming_soon: "Coming soon",
  available: "Available",
  connecting: "Connecting",
  connected: "Connected",
  action_needed: "Needs attention",
};

const FILTERS = [
  { id: "all", label: "All" },
  { id: "connected", label: "Connected" },
  { id: "available", label: "Available" },
] as const;

type Filter = (typeof FILTERS)[number]["id"];

/* The person's word for the state, not the column's. */
function accountLabel(status: string): string {
  if (status === "revoked") return "Disconnected";
  return status;
}

export function ConnectorCatalog({
  connectors,
  authorizedSenders = null,
}: {
  connectors: CatalogConnector[];
  /** ASH-289: the gmail.send grant; absent means unrestricted. */
  authorizedSenders?: string[] | null;
}) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return connectors.filter((connector) => {
      const state = cardState(connector);
      if (filter === "connected" && state !== "connected") return false;
      if (filter === "available" && (state === "connected" || state === "coming_soon" || state === "needs_config")) return false;
      if (!needle) return true;
      return connector.displayName.toLowerCase().includes(needle);
    });
  }, [connectors, query, filter]);

  const groups = useMemo(() => {
    const byCategory = new Map<string, CatalogConnector[]>();
    for (const connector of visible) {
      const category = CATEGORY_BY_PROVIDER[connector.provider] ?? "Other";
      byCategory.set(category, [...(byCategory.get(category) ?? []), connector]);
    }
    return [...byCategory.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [visible]);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center gap-3">
        <SearchField value={query} onChange={setQuery} placeholder="Search connectors" />
        <div role="group" aria-label="Filter connectors" className="flex gap-1.5">
          {FILTERS.map((option) => (
            <button
              key={option.id}
              type="button"
              aria-pressed={filter === option.id}
              onClick={() => setFilter(option.id)}
              className={cn(
                "min-h-8 rounded-md border px-3 text-[13px]",
                filter === option.id
                  ? "border-border bg-muted font-medium text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground",
              )}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>

      {groups.map(([category, items]) => (
        <section key={category} aria-label={category}>
          <h2 className="pb-2 text-[11px] font-medium text-muted-foreground">{category}</h2>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
            {items.map((connector) => {
              const state = cardState(connector);
              return (
                <article
                  key={connector.provider}
                  className={cn("panel flex flex-col gap-3 rounded-xl p-3.5", state === "coming_soon" && "opacity-70")}
                >
                  <div className="flex items-start gap-3">
                    <span className="product-mark size-8" aria-hidden>
                      <ProviderIcon provider={connector.provider} displayName={connector.displayName} />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center justify-between gap-2">
                        <h3 className="min-w-0 truncate text-[13px] font-medium">{connector.displayName}</h3>
                        <Status>{STATE_LABEL[state]}</Status>
                      </div>
                    </div>
                  </div>

                  {state === "connected" ? (
                    <div className="divide-y divide-border border-t border-border">
                      {connector.accounts
                        .filter((account) => account.status === "active")
                        .map((account) => (
                          <div key={account.id} className="py-3">
                            <div className="mb-1.5 flex flex-wrap items-center gap-2">
                              <p className="text-[13px] font-medium">{account.alias}</p>
                              {account.isDefaultForWrites ? <Status>write default</Status> : null}
                            </div>
                            <p className="mb-2 text-xs text-muted-foreground">
                              {account.lastHealthyAt
                                ? `Healthy ${account.lastHealthyAt.slice(0, 16).replace("T", " ")}Z`
                                : "No health check yet"}
                            </p>
                            <AccessToggles
                              provider={connector.provider}
                              accountId={account.id}
                              expectedVersion={account.version}
                              currentTier={account.accessTier}
                              disabled={account.disabledCapabilities}
                            />
                            <div className="mt-2">
                              <AccountControls
                                provider={connector.provider}
                                accountId={account.id}
                                version={account.version}
                                status={account.status}
                                isDefault={account.isDefaultForWrites}
                                alias={account.alias}
                                senderProposalsEnabled={account.senderProposalsEnabled}
                                senderProposalsBlocked={senderProposalsBlockedReason(account)}
                              />
                            </div>
                          </div>
                        ))}
                      {connector.accounts
                        .filter((account) => account.status !== "active")
                        .map((account) => (
                          <div key={account.id} className="py-3">
                            <p className="text-[13px] font-medium">{account.alias}</p>
                            <p className="mt-1 text-xs text-muted-foreground">{accountLabel(account.status)}.</p>
                            {connector.provider === "gmail" ? (
                              <div className="mt-2">
                                <SenderProposalsRow
                                  accountId={account.id}
                                  version={account.version}
                                  alias={account.alias}
                                  enabled={account.senderProposalsEnabled}
                                  blocked={senderProposalsBlockedReason(account)}
                                />
                              </div>
                            ) : null}
                          </div>
                        ))}
                      <div className="pt-3">
                        <ConnectButton provider={connector.provider} label="Connect another" />
                      </div>
                      {connector.provider === "gmail" ? (
                        <SenderGrantControls
                          aliases={connector.accounts
                            .filter((account) => account.status === "active")
                            .map((account) => account.alias)}
                          authorized={authorizedSenders ?? []}
                        />
                      ) : null}
                    </div>
                  ) : null}

                  {state === "connecting" ? (
                    <div className="border-t border-border pt-3">
                      {connector.accounts.map((account) => (
                        <div key={account.id} className="mb-2">
                          <p className="text-[13px] font-medium">{account.alias}</p>
                          <p className="mt-1 mb-2 text-xs text-muted-foreground">Finish connecting to start using it.</p>
                          <ConnectButton provider={connector.provider} alias={account.alias} label="Finish connecting" />
                        </div>
                      ))}
                    </div>
                  ) : null}

                  {state === "available" && !isInstantConnector(connector) ? (
                    <div className="border-t border-border pt-3">
                      <ConnectButton provider={connector.provider} />
                    </div>
                  ) : null}

                  {state === "action_needed" ? (
                    <div className="border-t border-border pt-3">
                      {connector.accounts.map((account) => (
                        <div key={account.id} className="mb-2">
                          <p className="text-[13px] font-medium">{account.alias}</p>
                          {account.lastError ? (
                            <p className="mt-1 mb-2 text-xs text-muted-foreground">{account.lastError}</p>
                          ) : null}
                          <ConnectButton
                            provider={connector.provider}
                            alias={account.status === "revoked" ? undefined : account.alias}
                            label="Reconnect"
                          />
                          {connector.provider === "gmail" ? (
                            <div className="mt-2">
                              <SenderProposalsRow
                                accountId={account.id}
                                version={account.version}
                                alias={account.alias}
                                enabled={account.senderProposalsEnabled}
                                blocked={senderProposalsBlockedReason(account)}
                              />
                            </div>
                          ) : null}
                        </div>
                      ))}
                    </div>
                  ) : null}

                  {state === "needs_config" ? (
                    <p className="border-t border-border pt-3 text-xs text-muted-foreground">
                      Setup needed on this deployment: set {connector.missingConfig.join(" and ")}. Until then{" "}
                      {connector.displayName} cannot connect.
                    </p>
                  ) : null}

                  {state === "coming_soon" ? (
                    <p className="border-t border-border pt-3 text-xs text-muted-foreground">
                      Connect {connector.displayName} agents once its tools ship.
                    </p>
                  ) : null}

                  {isInstantConnector(connector) ? (
                    <div className="border-t border-border pt-3">
                      <p className="text-[13px] font-medium">No connection needed</p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        Agents can use this instantly; calls bill the workspace&apos;s tool budget.
                      </p>
                    </div>
                  ) : null}
                </article>
              );
            })}
          </div>
        </section>
      ))}

      {!visible.length ? (
        <Empty
          title="No matching connectors"
          description={
            query
              ? `Nothing in the catalog matches "${query}". Clear the search or the filter.`
              : "No connectors in this state yet."
          }
        />
      ) : null}
    </div>
  );
}
