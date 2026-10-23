"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { CAPABILITY_LABELS, PROVIDER_TIERS, type Provider } from "@/domains/integrations/capabilities";
import {
  renameAccountAction,
  revokeAccountAction,
  setAccountAccessTierAction,
  setAccountCapabilityAction,
  setWriteDefaultAction,
  startConnectionAction,
  syncGoogleCalendarAction,
  syncNotionAction,
} from "./actions";

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
      <RenameAccount accountId={accountId} version={version} alias={alias} />
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

/*
 * Naming happens after connect, not before it. An auto-named connection
 * becomes "work" or "personal" here; models choose accounts by this name.
 */
function RenameAccount({ accountId, version, alias }: { accountId: string; version: number; alias: string }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(alias);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  if (!editing) {
    return (
      <Button
        size="sm"
        variant="ghost"
        onClick={() => {
          setName(alias);
          setError(null);
          setEditing(true);
        }}
      >
        Rename
      </Button>
    );
  }

  const save = () => {
    setError(null);
    startTransition(async () => {
      const result = await renameAccountAction({ accountId, expectedVersion: version, alias: name });
      if (result.ok) {
        setEditing(false);
      } else {
        setError(result.error);
      }
    });
  };

  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <Input
        value={name}
        onChange={(event) => setName(event.target.value)}
        maxLength={60}
        className="h-8 w-44 text-[13px]"
        aria-label="Account name"
        autoFocus
        onKeyDown={(event) => {
          if (event.key === "Enter") save();
          if (event.key === "Escape") setEditing(false);
        }}
      />
      <Button size="sm" variant="outline" disabled={pending || !name.trim()} onClick={save}>
        Save
      </Button>
      <Button size="sm" variant="ghost" disabled={pending} onClick={() => setEditing(false)}>
        Cancel
      </Button>
      {error ? <span className="text-xs text-destructive">{error}</span> : null}
    </span>
  );
}

/*
 * The hosted-auth entry point: one click begins the attempt and navigates to
 * the provider's consent screen. No name is asked for up front; the flow
 * names the account itself when `alias` is absent (a resume passes the
 * existing alias so the attempt continues instead of duplicating).
 */
export function ConnectButton({
  provider,
  alias,
  label = "Connect",
}: {
  provider: string;
  alias?: string;
  label?: string;
}) {
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const connect = () => {
    setError(null);
    startTransition(async () => {
      const result = await startConnectionAction(alias ? { provider, alias } : { provider });
      if (result.ok) {
        window.location.assign(result.redirectUrl);
      } else {
        setError(result.error);
      }
    });
  };

  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <Button type="button" variant="outline" size="sm" disabled={pending} onClick={connect}>
        {pending ? "Opening…" : label}
      </Button>
      {error ? <span className="text-xs text-destructive">{error}</span> : null}
    </span>
  );
}

/*
 * The coarse control: what agents may do through this connection, as one
 * choice. Each choice saves itself; the row remounts when the server returns
 * a new version, which is what settles it.
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

/*
 * The fine-grained control under the tier: one switch per capability the
 * current tier grants. The tier is the ceiling — a switch can only narrow
 * what this one account allows, never grant above the tier — and the gateway
 * enforces the switch live on every call, so off means off immediately.
 */
export function CapabilitySwitches({
  provider,
  accountId,
  expectedVersion,
  current,
  disabled,
}: {
  provider: string;
  accountId: string;
  expectedVersion: number;
  current: string | null;
  disabled: string[];
}) {
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const tiers = PROVIDER_TIERS[provider as Provider] ?? [];
  const active = tiers.find((tier) => tier.id === current) ?? tiers[0];

  if (!active) return null;

  const toggle = (capability: string, enabled: boolean) => {
    setError(null);
    startTransition(async () => {
      const result = await setAccountCapabilityAction({ accountId, expectedVersion, capability, enabled });
      if (!result.ok) setError(result.error);
    });
  };

  return (
    <div className="flex flex-col gap-1.5">
      <p className="text-xs text-muted-foreground">This account can</p>
      {active.capabilities.map((capability) => {
        const enabled = !disabled.includes(capability);
        return (
          <div key={capability} className="flex items-center justify-between gap-3">
            <span className="text-[13px]">{CAPABILITY_LABELS[capability] ?? capability}</span>
            <button
              type="button"
              role="switch"
              aria-checked={enabled}
              aria-label={CAPABILITY_LABELS[capability] ?? capability}
              disabled={pending}
              onClick={() => toggle(capability, !enabled)}
              className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${
                enabled ? "bg-foreground" : "bg-muted-foreground/30"
              }`}
            >
              <span
                aria-hidden
                className={`absolute top-0.5 h-4 w-4 rounded-full bg-background transition-transform ${
                  enabled ? "translate-x-4.5 left-0" : "translate-x-0.5 left-0"
                }`}
              />
            </button>
          </div>
        );
      })}
      {error ? <p className="text-xs text-destructive" role="status">{error}</p> : null}
    </div>
  );
}
