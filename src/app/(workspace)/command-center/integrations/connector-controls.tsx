"use client";

import { useId, useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Field } from "@/components/workspace/ui";
import { cn } from "cn";
import { registerAccountAction, revokeAccountAction, setAccountPermissionAction, setAccountStatusAction, setWriteDefaultAction, startConnectionAction, syncGoogleCalendarAction, syncNotionAction } from "./actions";

/* Connector card islands over the durable integrations rows. */

/*
 * One account's permission switches. Each switch saves itself, so there is no
 * Save button and no confirmation dialog: the copy states the consequence and
 * the control is the commit. Local state is optimistic; the row remounts when
 * the server returns a new `version`, which is what settles it.
 */
export function AccountPermissions({
  accountId,
  version,
  allowRead,
  allowWrite,
  writeCapable,
}: {
  accountId: string;
  version: number;
  allowRead: boolean;
  allowWrite: boolean;
  writeCapable: boolean;
}) {
  const [override, setOverride] = useState<{ allowRead: boolean; allowWrite: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const value = override ?? { allowRead, allowWrite };

  const save = (next: { allowRead: boolean; allowWrite: boolean }) => {
    // Write without read has no meaning - a proposal has to cite what it read -
    // so turning read off takes write with it in the same write.
    const coherent = next.allowRead ? next : { allowRead: false, allowWrite: false };
    setError(null);
    setOverride(coherent);
    startTransition(async () => {
      const result = await setAccountPermissionAction({
        accountId,
        expectedVersion: version,
        allowRead: coherent.allowRead,
        allowWrite: coherent.allowWrite,
      });
      if (!result.ok) {
        setOverride(null);
        setError(result.error);
      }
    });
  };

  const readId = useId();
  const writeId = useId();

  return (
    <div className="flex flex-col gap-3 pt-1">
      <PermissionSwitch
        id={readId}
        label="Read"
        description="Search and read. Runs immediately."
        checked={value.allowRead}
        pending={pending}
        onChange={(next) => save({ allowRead: next, allowWrite: value.allowWrite })}
      />
      <PermissionSwitch
        id={writeId}
        label="Write"
        // The description slot carries the reason when writing is impossible,
        // so the row is one line either way and the card never jumps.
        description={writeCapable ? "Propose changes for your approval. Nothing is sent directly." : "This provider is read-only. Nothing can be proposed."}
        checked={value.allowWrite}
        disabled={!writeCapable}
        pending={pending}
        onChange={(next) => save({ allowRead: value.allowRead, allowWrite: next })}
      />
      {error ? <p className="text-xs text-muted-foreground" role="status">{error}</p> : null}
    </div>
  );
}

function PermissionSwitch({
  id,
  label,
  description,
  checked,
  disabled = false,
  pending,
  onChange,
}: {
  id: string;
  label: string;
  description: string;
  checked: boolean;
  disabled?: boolean;
  pending: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0">
        <span id={`${id}-label`} className="text-[13px] leading-5">{label}</span>
        <p className="mt-2 min-h-8 text-xs leading-4 text-muted-foreground">{description}</p>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-labelledby={`${id}-label`}
        disabled={disabled || pending}
        onClick={() => onChange(!checked)}
        className={cn(
          "relative mt-0.5 h-5 w-9 shrink-0 rounded-full border border-border transition-colors disabled:cursor-not-allowed disabled:opacity-50",
          checked ? "bg-foreground/70" : "bg-muted",
        )}
      >
        <span
          className={cn(
            "absolute top-0.5 size-3.5 rounded-full bg-background transition-[left]",
            checked ? "left-[18px]" : "left-[2px]",
          )}
        />
      </button>
    </div>
  );
}

export function RegisterForm({ providers }: { providers: Array<{ provider: string; displayName: string }> }) {
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  return (
    <form
      className="grid gap-3 sm:grid-cols-3"
      onSubmit={(event) => {
        event.preventDefault();
        const data = new FormData(event.currentTarget);
        setError(null);
        startTransition(async () => {
          const result = await registerAccountAction({
            provider: String(data.get("provider") || ""),
            alias: String(data.get("alias") || ""),
          });
          if (result.ok) {
            event.currentTarget.reset();
          } else {
            setError(result.error);
          }
        });
      }}
    >
      <Field label="Provider">
        <Select name="provider">
          {providers.map((p) => (
            <option key={p.provider} value={p.provider}>{p.displayName}</option>
          ))}
        </Select>
      </Field>
      <Field label="Alias">
        <Input name="alias" required maxLength={60} placeholder="work-gmail" />
      </Field>
      <div className="flex items-end gap-3">
        <Button type="submit" disabled={pending}>{pending ? "Registering…" : "Register account"}</Button>
        {error ? <p className="text-destructive text-[13px]" role="alert">{error}</p> : null}
      </div>
    </form>
  );
}

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
      {status === "connecting" ? (
        <Button
          size="sm"
          variant="outline"
          disabled={pending}
          onClick={() => act(setAccountStatusAction, { accountId, expectedVersion: version, status: "active" })}
        >
          Mark connected
        </Button>
      ) : null}
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

export function ConnectButton({ provider, defaultAlias }: { provider: string; defaultAlias: string }) {
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  return (
    <span className="inline-flex items-center gap-2">
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={pending}
        onClick={() => {
          setError(null);
          startTransition(async () => {
            const result = await startConnectionAction({ provider, alias: defaultAlias });
            if (result.ok) {
              window.location.assign(result.redirectUrl);
            } else {
              setError(result.error);
            }
          });
        }}
      >
        {pending ? "Opening…" : "Connect"}
      </Button>
      {error ? <span className="text-xs text-destructive">{error}</span> : null}
    </span>
  );
}
