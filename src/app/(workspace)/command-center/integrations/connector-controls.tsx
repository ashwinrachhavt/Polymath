"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { revokeAccountAction, setAccountAccessTierAction, setWriteDefaultAction, startConnectionAction, syncGoogleCalendarAction, syncNotionAction } from "./actions";

/* Connector card islands over the durable integrations rows. */

export function AccountControls({
  accountId,
  version,
  status,
  isDefault,
  provider,
  alias,
}: {
  provider?: string;
  accountId: string;
  version: number;
  status: string;
  isDefault: boolean;
  alias: string;
}) {
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const act = (action: (input: never) => Promise<{ ok: true } | { ok: false; error: string }>, input: Record<string, unknown>) => {
    setError(null);
    startTransition(async () => {
      const result = await action(input as never);
      if (!result.ok) setError(result.error);
    });
  };

  return (
    <div className="flex flex-wrap items-center gap-2">
      {status !== "revoked" ? (
        <Button
          size="sm"
          variant="ghost"
          disabled={pending}
          onClick={() => {
            // The confirmation names the consequence, not the button: nothing
            // in this workspace can use the account afterwards.
            if (!window.confirm(`Disconnect ${alias}? Nothing in Polymath will be able to read or send with it.`)) return;
            act(revokeAccountAction, { accountId, expectedVersion: version });
          }}
        >
          Disconnect
        </Button>
      ) : null}
      {status === "active" && !isDefault ? (
        <Button
          size="sm"
          variant="outline"
          disabled={pending}
          onClick={() => act(setWriteDefaultAction, { accountId, expectedVersion: version })}
        >
          Make write default
        </Button>
      ) : null}
      {(provider === "google-calendar" || provider === "notion") && status === "active" ? (
        <Button
          size="sm"
          variant="outline"
          disabled={pending}
          onClick={() => {
            setError(null);
            startTransition(async () => {
              const result = await (provider === "notion" ? syncNotionAction : syncGoogleCalendarAction)({ accountId });
              setError(result.ok ? `Synced: ${result.summary}` : result.error);
            });
          }}
        >
          Sync now
        </Button>
      ) : null}
      {error ? <p className="text-[13px] text-muted-foreground" role="status">{error}</p> : null}
    </div>
  );
}

/* The hosted-auth entry point: begins the attempt and navigates to Composio. */

export function ConnectButton({
  provider,
  defaultAlias,
  label = "Connect",
  promptForAlias = false,
}: {
  provider: string;
  defaultAlias: string;
  label?: string;
  promptForAlias?: boolean;
}) {
  const [alias, setAlias] = useState(defaultAlias);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const connect = () => {
    setError(null);
    startTransition(async () => {
      const result = await startConnectionAction({ provider, alias: alias.trim() });
      if (result.ok) {
        window.location.assign(result.redirectUrl);
      } else {
        setError(result.error);
      }
    });
  };

  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      {promptForAlias ? (
        <Input
          value={alias}
          onChange={(event) => setAlias(event.target.value)}
          placeholder="name this account, e.g. work"
          maxLength={60}
          className="h-8 w-44 text-[13px]"
          aria-label="Account name"
        />
      ) : null}
      <Button type="button" variant="outline" size="sm" disabled={pending || (promptForAlias && !alias.trim())} onClick={connect}>
        {pending ? "Opening…" : label}
      </Button>
      {error ? <span className="text-xs text-destructive">{error}</span> : null}
    </span>
  );
}

/*
 * The one control that sets what agents may do through this connection. Each
 * choice saves itself; the row remounts when the server returns a new
 * version, which is what settles it.
 */
export function TierPicker({
  accountId,
  expectedVersion,
  current,
  tiers,
}: {
  provider: string;
  accountId: string;
  expectedVersion: number;
  current: string | null;
  tiers: Array<{ id: string; label: string; description: string }>;
}) {
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const active = tiers.find((tier) => tier.id === current) ?? tiers[0];

  if (!active) return null;

  const choose = (tierId: string) => {
    setError(null);
    startTransition(async () => {
      const result = await setAccountAccessTierAction({ accountId, expectedVersion, tierId });
      if (!result.ok) setError(result.error);
    });
  };

  return (
    <div className="flex flex-col gap-1">
      <label className="text-xs text-muted-foreground" htmlFor={`tier-${accountId}`}>
        Agent access
      </label>
      <select
        id={`tier-${accountId}`}
        value={active.id}
        disabled={pending}
        onChange={(event) => choose(event.target.value)}
        className="h-8 w-full rounded-md border border-border bg-background px-2 text-[13px]"
      >
        {tiers.map((tier) => (
          <option key={tier.id} value={tier.id}>
            {tier.label}
          </option>
        ))}
      </select>
      <p className="text-xs text-muted-foreground">{active.description}</p>
      {error ? <p className="text-xs text-destructive" role="status">{error}</p> : null}
    </div>
  );
}