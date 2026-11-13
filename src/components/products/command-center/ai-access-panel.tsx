"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { DeleteButton } from "@/components/ui/delete-button";
import { Input } from "@/components/ui/input";
import { Field, Unavailable } from "@/components/workspace/ui";
import {
  deleteModelKeyAction,
  loadAiAccessAction,
  saveModelKeyAction,
  setProAction,
  type AiAccessDto,
} from "@/app/(workspace)/settings/ai-access-actions";

/*
 * Settings → AI access. Self-contained: it loads and saves through
 * ai-access-actions and shares nothing with its neighbours. The free plan
 * runs on Polymath's model for a small weekly allowance; a key of your own
 * lifts the limit and is billed by your provider, not by us. A saved key shows
 * its last four characters and nothing more.
 */

const dayFormat = new Intl.DateTimeFormat("en-US", { weekday: "long", month: "short", day: "numeric" });

function summary(access: AiAccessDto): string {
  if (access.plan === "own-key")
    return "Using your own key. Calls go straight to your provider, with no limit from Polymath.";
  const name = access.plan === "pro" ? "Pro" : "Free";
  return `${name} plan: ${access.used} of ${access.allowance} AI calls used this week. Resets ${dayFormat.format(new Date(access.resetsAt))}.`;
}

export default function AiAccessPanel() {
  const [access, setAccess] = useState<AiAccessDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [provider, setProvider] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [saving, setSaving] = useState(false);

  const reload = () => {
    void loadAiAccessAction().then((result) => {
      if (result.ok) {
        setAccess(result.access);
        setProvider((current) => current || result.access.providers[0]?.id || "");
      } else setError(result.error);
    });
  };
  useEffect(reload, []);

  if (error && !access) return <Unavailable feature="AI access">{error}</Unavailable>;
  if (!access) {
    return (
      <p role="status" className="text-body-dense text-muted-foreground">
        Loading AI access…
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      <p className="text-body-dense">{summary(access)}</p>

      {access.keys.length > 0 ? (
        <ul className="divide-y rounded-md border">
          {access.keys.map((key) => (
            <li key={key.provider} className="flex items-center justify-between gap-3 px-3 py-2 text-body-dense">
              <span>
                {key.label} <span className="readout text-muted-foreground">•••• {key.last4}</span>
              </span>
              {access.canManage ? (
                <DeleteButton
                  label={`Remove ${key.label} key`}
                  deletedMessage="Key removed"
                  confirmHint="Click again to remove it. Calls fall back to Polymath's model and the weekly allowance."
                  onDelete={async () => {
                    const result = await deleteModelKeyAction({ provider: key.provider });
                    if (!result.ok) throw new Error(result.error);
                    reload();
                  }}
                />
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}

      {access.canManage ? (
        access.canStoreKeys ? (
          <form
            className="grid gap-3 sm:grid-cols-[12rem_1fr_auto] sm:items-end"
            onSubmit={(event) => {
              event.preventDefault();
              setSaving(true);
              setError(null);
              void saveModelKeyAction({ provider, apiKey }).then((result) => {
                setSaving(false);
                if (!result.ok) {
                  setError(result.error);
                  return;
                }
                setApiKey("");
                reload();
              });
            }}
          >
            <Field label="Provider">
              <select
                value={provider}
                onChange={(event) => setProvider(event.target.value)}
                className="h-9 rounded-md border border-input bg-background px-3 text-body-dense"
              >
                {access.providers.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="API key">
              <Input
                required
                type="password"
                autoComplete="off"
                spellCheck={false}
                value={apiKey}
                onChange={(event) => setApiKey(event.target.value)}
                placeholder="Paste a key to add or replace it"
              />
            </Field>
            <Button type="submit" variant="outline" disabled={saving || apiKey.trim() === ""}>
              {saving ? "Checking…" : "Add key"}
            </Button>
          </form>
        ) : (
          <p className="text-body-dense text-muted-foreground">
            This deployment cannot store keys: SECRETS_ENCRYPTION_KEY is not set.
          </p>
        )
      ) : (
        <p className="text-body-dense text-muted-foreground">Only the workspace owner can add or remove keys.</p>
      )}
      {error ? (
        <p role="alert" className="text-body-dense text-destructive">
          {error}
        </p>
      ) : null}

      {access.canManage && access.plan !== "own-key" ? (
        <div className="flex items-center gap-3 border-t pt-4">
          <Button
            variant="outline"
            onClick={() => {
              void setProAction({ pro: access.plan !== "pro" }).then((result) => {
                if (result.ok) reload();
                else setError(result.error);
              });
            }}
          >
            {access.plan === "pro" ? "Switch back to Free" : "Switch to Pro"}
          </Button>
          <p className="text-xs text-muted-foreground">Pro is a manual switch until billing arrives.</p>
        </div>
      ) : null}
    </div>
  );
}
