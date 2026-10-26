"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { CAPABILITIES, PROVIDER_TIERS, type Provider } from "@/domains/integrations/capabilities";
import { accessToggleState, planToggleSteps, type ToggleStep } from "@/domains/integrations/access-toggles";
import {
  renameAccountAction,
  revokeAccountAction,
  setAccountAccessTierAction,
  setAccountCapabilityAction,
  setSenderAliasesAction,
  setSenderProposalsAction,
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
  senderProposalsEnabled,
}: {
  provider?: string;
  accountId: string;
  version: number;
  status: string;
  isDefault: boolean;
  alias: string;
  senderProposalsEnabled?: boolean;
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
      {provider === "gmail" && status === "active" ? (
        <div className="flex w-full items-start justify-between gap-3 rounded-md border border-border px-3 py-2">
          <span className="text-[13px]">
            <span className="font-medium">Suggest contacts from new senders</span>
            <span className="block text-xs text-muted-foreground">
              Once a day, Polymath reads new inbound senders on {alias} and turns them into contact proposals in Reviews. Read-only: no mail is
              written, labeled, or sent, and nothing becomes a contact without your approval. Starts from the moment you turn it on.
            </span>
          </span>
          <Switch
            checked={senderProposalsEnabled ?? false}
            disabled={pending}
            aria-label="Suggest contacts from new senders"
            onCheckedChange={(enabled) => act(setSenderProposalsAction, { accountId, expectedVersion: version, enabled })}
          />
        </div>
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

  if (!tiers.length) return null;

  const run = async (steps: ToggleStep[]) => {
    setError(null);
    startTransition(async () => {
      // Each call bumps the account version, so a later step in the same
      // transition must expect the bumped version. A failed step is reported
      // as-is; earlier steps are not rolled back.
      for (const step of steps) {
        const result =
          step.kind === "tier"
            ? await setAccountAccessTierAction({ accountId, expectedVersion: step.expectedVersion, tierId: step.tierId })
            : await setAccountCapabilityAction({
                accountId,
                expectedVersion: step.expectedVersion,
                capability: step.capability,
                enabled: step.enabled,
              });
        if (!result.ok) {
          setError(result.error);
          return;
        }
      }
    });
  };

  // The step sequence for every flip is the pure plan in access-toggles.ts,
  // offset by the version the card was rendered with.
  const flip = (toggle: "read" | "write", on: boolean) => {
    const steps = planToggleSteps({ provider: providerKey, currentTier, disabled, toggle, on });
    if (!steps.length) return;
    run(steps.map((step) => ({ ...step, expectedVersion: step.expectedVersion + expectedVersion })));
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
        <Switch
          checked={on}
          disabled={pending}
          aria-label={label}
          onCheckedChange={toggle}
        />
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
        () => flip("read", !state.read.on),
      )}
      {state.write
        ? toggleRow(
            state.write.label,
            state.write.label === "Send"
              ? "Agents can draft send proposals for your approval"
              : "Agents can draft proposals for your approval",
            state.write.on,
            state.write.available,
            () => flip("write", !state.write?.on),
          )
        : null}
      {error ? <p className="text-xs text-destructive" role="status">{error}</p> : null}
    </div>
  );
}

/*
 * ASH-289: the sending grant editor. Each connected Gmail account is one
 * checkbox; only checked aliases may send. Until any grant is saved the
 * account is unrestricted; saving with none checked is a real choice that
 * blocks every sender, and the copy says so.
 */
export function SenderGrantControls({
  aliases,
  authorized,
}: {
  aliases: string[];
  authorized: string[];
}) {
  const [checked, setChecked] = useState<string[]>(authorized);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const dirty =
    checked.length !== authorized.length || checked.some((alias) => !authorized.includes(alias));

  const toggle = (alias: string) =>
    setChecked((current) => (current.includes(alias) ? current.filter((a) => a !== alias) : [...current, alias]));

  const save = () => {
    setMessage(null);
    setError(null);
    startTransition(async () => {
      const result = await setSenderAliasesAction({ aliases: checked });
      if (result.ok) setMessage("Sending grants saved.");
      else setError(result.error);
    });
  };

  return (
    <div className="border-t border-border pt-3" data-testid="sender-grants">
      <p className="text-[13px] font-medium">Sending grants</p>
      <p className="mt-1 text-xs text-muted-foreground">
        Only checked accounts may send email. Until a grant is saved, any connected account may send; saving with
        none checked blocks all sending. A proposal that names no account resolves only inside this list.
      </p>
      <div className="mt-2 flex flex-col gap-1.5">
        {aliases.map((alias) => (
          <label key={alias} className="flex min-h-8 items-center gap-2 text-[13px]">
            <input
              type="checkbox"
              checked={checked.includes(alias)}
              onChange={() => toggle(alias)}
              disabled={pending}
              className="size-4"
            />
            <span>{alias}</span>
          </label>
        ))}
      </div>
      {dirty ? (
        <Button size="sm" className="mt-2" onClick={save} disabled={pending}>
          Save sending grants
        </Button>
      ) : null}
      {message ? (
        <p role="status" className="mt-2 text-xs text-muted-foreground">
          {message}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="mt-2 text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
