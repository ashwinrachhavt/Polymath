"use client";

import { useMemo, useState } from "react";
import { Empty, SearchField, Status } from "@/components/workspace/ui";
import { cn } from "cn";
import { AccountControls, ConnectButton } from "./connector-controls";

/*
 * The catalog view follows the dark Connectors reference the owner sent
 * (Perplexity): a search field, an All / Connected / Available filter, and
 * category groups of quiet cards - one per provider - with a monochrome tile,
 * the capability summary, and the account rows with their controls. Cards use
 * the shared .panel edge recipe, so both themes stay in the token system.
 */

export type CatalogAccount = {
  id: string;
  alias: string;
  status: string;
  displayName: string | null;
  isDefaultForWrites: boolean;
  lastHealthyAt: string | null;
  lastError: string | null;
  version: number;
};

export type CatalogConnector = {
  provider: string;
  displayName: string;
  capabilities: string[];
  riskByCapability: Record<string, string>;
  accounts: CatalogAccount[];
};

const CATEGORY_BY_PROVIDER: Record<string, string> = {
  gmail: "Communication",
  slack: "Communication",
  "google-calendar": "Planning",
  linear: "Planning",
  notion: "Knowledge",
  github: "Developer",
};

const FILTERS = [
  { id: "all", label: "All" },
  { id: "connected", label: "Connected" },
  { id: "available", label: "Available" },
] as const;

type Filter = (typeof FILTERS)[number]["id"];

function connectorState(connector: CatalogConnector): "connected" | "connecting" | "available" {
  if (connector.accounts.some((account) => account.status === "active")) return "connected";
  if (connector.accounts.some((account) => account.status === "connecting")) return "connecting";
  return "available";
}

function capabilitySummary(connector: CatalogConnector): string {
  return connector.capabilities
    .map((capability) => `${capability.replaceAll("_", " ")} (${connector.riskByCapability[capability] ?? "read"})`)
    .join(" · ");
}

export function ConnectorCatalog({ connectors }: { connectors: CatalogConnector[] }) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return connectors.filter((connector) => {
      const state = connectorState(connector);
      if (filter === "connected" && state !== "connected") return false;
      if (filter === "available" && state === "connected") return false;
      if (!needle) return true;
      return (
        connector.displayName.toLowerCase().includes(needle) ||
        connector.capabilities.some((capability) => capability.replaceAll("_", " ").includes(needle))
      );
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
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {items.map((connector) => {
              const state = connectorState(connector);
              return (
                <article key={connector.provider} className="panel flex flex-col gap-3 rounded-xl p-4">
                  <div className="flex items-start gap-3">
                    <span className="product-mark" aria-hidden>
                      {connector.displayName.slice(0, 1)}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center justify-between gap-2">
                        <h3 className="text-[13px] font-medium">{connector.displayName}</h3>
                        <Status>{state === "connected" ? "Connected" : state === "connecting" ? "Connecting" : "Available"}</Status>
                      </div>
                      <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{capabilitySummary(connector)}</p>
                    </div>
                  </div>

                  {connector.accounts.length ? (
                    <div className="divide-y divide-border border-t border-border">
                      {connector.accounts.map((account) => (
                        <div key={account.id} className="py-3">
                          <div className="mb-1.5 flex flex-wrap items-center gap-2">
                            <p className="text-[13px] font-medium">{account.alias}</p>
                            <Status>{account.status}</Status>
                            {account.isDefaultForWrites ? <Status>write default</Status> : null}
                          </div>
                          <p className="mb-2 text-xs text-muted-foreground">
                            {account.lastHealthyAt
                              ? `Healthy ${account.lastHealthyAt.slice(0, 16).replace("T", " ")}Z`
                              : "Never connected"}
                            {account.lastError ? ` · ${account.lastError}` : ""}
                          </p>
                          <AccountControls
                            provider={connector.provider}
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
                  ) : (
                    <p className="border-t border-border pt-3 text-xs text-muted-foreground">
                      No account yet. Register a {connector.displayName} account below to start a connection.
                    </p>
                  )}
                </article>
              );
            })}
          </div>
        </section>
      ))}

      {!visible.length ? (
        <Empty
          title="No matching connectors"
          description={query ? `Nothing in the catalog matches "${query}". Clear the search or the filter.` : "No connectors in this state yet."}
        />
      ) : null}
    </div>
  );
}
