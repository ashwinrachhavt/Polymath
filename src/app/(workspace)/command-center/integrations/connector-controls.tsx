"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Field } from "@/components/workspace/ui";
import { registerAccountAction, setAccountStatusAction, setWriteDefaultAction, startConnectionAction, syncGoogleCalendarAction, syncNotionAction } from "./actions";

/* Connector card islands over the durable integrations rows. */

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
}: {
  provider?: string;
  accountId: string;
  version: number;
  status: string;
  isDefault: boolean;
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
          onClick={() => act(setAccountStatusAction, { accountId, expectedVersion: version, status: "revoked" })}
        >
          Revoke
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
