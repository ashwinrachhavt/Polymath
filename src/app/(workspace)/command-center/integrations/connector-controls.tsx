"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { CAPABILITIES, PROVIDER_TIERS, type Capability, type Provider } from "@/domains/integrations/capabilities";
import { accessToggleState, writeCapability } from "@/domains/integrations/access-toggles";
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

/*
 * A provider with no write capability can never honor "Make write default" -
 * the button is hidden rather than shown to fail, because a card never shows
 * a control its state cannot honor.
 */
const PROVIDERS_WITH_WRITES = new Set<string>(Object.values(CAPABILITIES).filter((spec) => spec.kind === "proposal").map((spec) => spec.provider));

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
      {status === "active" && !isDefault && provider !== undefined && PROVIDERS_WITH_WRITES.has(provider) ? (
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
 * The owner's view of what agents may do through one account: a Read switch
 * and, when the provider can act at all, a Write switch (Send for Gmail).
 * The tier machinery underneath is unchanged — Write on raises the tier to
 * the one granting the write capability, Write off narrows via the account's
 * disabled list — so the gateway's live checks are untouched.
 */
export function AccessToggles({
  provider,
  accountId,
  expectedVersion,
  currentTier,
  disabled,
}: {
  provider: string;
  accountId: string;
  expectedVersion: number;
  currentTier: string | null;
  disabled: string[];
}) {
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const providerKey = provider as Provider;
  const tiers = PROVIDER_TIERS[providerKey] ?? [];
  const state = accessToggleState(providerKey, currentTier, disabled);
  const write = writeCapability(providerKey);

  if (!tiers.length) return null;

  const run = async (steps: Array<{ expectedVersion: number; call: () => Promise<{ ok: true } | { ok: false; error: string }>}>) => {
    setError(null);
    startTransition(async () => {
      // Each call bumps the account version, so a later step in the same
      // transition must expect the bumped version. A failed step is reported
      // as-is; earlier steps are not rolled back.
      for (const step of steps) {
        const result = await step.call();
        if (!result.ok) {
          setError(result.error);
          return;
        }
      }
    });
  };

  // Write on = raise the tier first (a capability outside the tier is
  // rejected by the command), then clear any disable on the write capability.
  const writeOn = () => {
    const tierId = tiers.find((tier) => write && tier.capabilities.includes(write))?.id;
    if (!tierId || !write) return;
    const steps = [{ expectedVersion, call: () => setAccountAccessTierAction({ accountId, expectedVersion, tierId }) }];
    if (disabled.includes(write)) {
      steps.push({
        expectedVersion: expectedVersion + 1,
        call: () => setAccountCapabilityAction({ accountId, expectedVersion: expectedVersion + 1, capability: write, enabled: true }),
      });
    }
    run(steps);
  };

  // Read off = disable every read capability the current tier grants. This is
  // a legal narrowing, so no tier change is involved.
  const readOff = () => {
    const granted = tiers.find((tier) => tier.id === currentTier)?.capabilities ?? [];
    const reads = granted.filter((capability) => CAPABILITIES[capability as Capability]?.kind === "read" && !disabled.includes(capability));
    if (!reads.length) return;
    run(reads.map((capability, index) => ({
      expectedVersion: expectedVersion + index,
      call: () => setAccountCapabilityAction({ accountId, expectedVersion: expectedVersion + index, capability, enabled: false }),
    })));
  };

  // Read on = re-enable every read capability the current tier grants.
  const readOn = () => {
    const granted = tiers.find((tier) => tier.id === currentTier)?.capabilities ?? [];
    const reads = granted.filter((capability) => CAPABILITIES[capability as Capability]?.kind === "read" && disabled.includes(capability));
    if (!reads.length) return;
    run(reads.map((capability, index) => ({
      expectedVersion: expectedVersion + index,
      call: () => setAccountCapabilityAction({ accountId, expectedVersion: expectedVersion + index, capability, enabled: true }),
    })));
  };

  // Write off = disable the write capability only. Dropping the tier would be
  // redundant: capability switches may narrow, so the tier stays as the
  // ceiling and re-enabling is one switch flip away.
  const writeOff = () => {
    if (!write) return;
    run([{ expectedVersion, call: () => setAccountCapabilityAction({ accountId, expectedVersion, capability: write, enabled: false }) }]);
  };

  const toggleRow = (
    label: string,
    description: string,
    on: boolean,
    available: boolean,
    toggle: () => void,
  ) => (
    <div className="flex items-start justify-between gap-3">
      <span className="min-w-0">
        <span className="block text-[13px]">{label}</span>
        <span className="block text-xs text-muted-foreground">{description}</span>
      </span>
      {available ? (
        <button
          type="button"
          role="switch"
          aria-checked={on}
          aria-label={label}
          disabled={pending}
          onClick={toggle}
          className={`relative mt-0.5 h-5 w-9 shrink-0 rounded-full transition-colors ${
            on ? "bg-foreground" : "bg-muted-foreground/30"
          }`}
        >
          <span
            aria-hidden
            className={`absolute top-0.5 left-0 h-4 w-4 rounded-full bg-background transition-transform ${
              on ? "translate-x-4.5" : "translate-x-0.5"
            }`}
          />
        </button>
      ) : null}
    </div>
  );

  return (
    <div className="flex flex-col gap-2">
      {toggleRow(
        "Read",
        "Agents can read",
        state.read.on,
        state.read.available,
        state.read.on ? readOff : readOn,
      )}
      {state.write
        ? toggleRow(
            state.write.label,
            state.write.label === "Send"
              ? "Agents can draft send proposals for your approval"
              : "Agents can draft proposals for your approval",
            state.write.on,
            state.write.available,
            state.write.on ? writeOff : writeOn,
          )
        : null}
      {error ? <p className="text-xs text-destructive" role="status">{error}</p> : null}
    </div>
  );
}
