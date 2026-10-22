"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Empty, Field, Status, Unavailable } from "@/components/workspace/ui";
import {
  createApiKeyAction,
  listApiKeysAction,
  revokeApiKeyAction,
  type ApiKeyDto,
} from "@/app/(workspace)/settings/api-key-actions";

/*
 * API keys for the browser companion and other machine clients. One panel
 * covers the whole lifecycle: create (secret shown once, in a dialog), list
 * (prefix, scopes, last seen), revoke. The server stores only the secret's
 * digest, so nothing here can re-show a key after its dialog closes.
 */

const dateFormat = new Intl.DateTimeFormat("en-US", { dateStyle: "medium" });

const SCOPE_LABELS: Record<string, string> = {
  "captures:read": "Read captures",
  "captures:write": "Write captures",
};

function keyPrefix(key: ApiKeyDto): string {
  return key.keyId ? `axm_${key.keyId}…` : "legacy token";
}

export default function ApiKeysPanel() {
  const [keys, setKeys] = useState<ApiKeyDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [shownToken, setShownToken] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [confirmRevoke, setConfirmRevoke] = useState<string | null>(null);

  const reload = () => {
    void listApiKeysAction().then((result) => {
      if (result.ok) { setKeys(result.keys); setError(null); }
      else setError(result.error);
    });
  };
  useEffect(reload, []);

  if (error) {
    return <Unavailable feature="API keys">{error}</Unavailable>;
  }
  if (keys === null) {
    return <p role="status" className="text-[13px] text-muted-foreground">Loading API keys…</p>;
  }

  return (
    <div className="flex flex-col gap-5">
      {keys.length === 0 ? (
        <Empty
          title="No API keys yet"
          description="The Chrome companion and any script or agent authenticate with an API key. Create one, paste it into the client once, and revoke it here when it should stop working."
        />
      ) : (
        <table className="w-full text-[13px]">
          <thead>
            <tr className="border-b text-left text-xs text-muted-foreground">
              <th className="py-2 font-medium">Key</th>
              <th className="py-2 font-medium">Scopes</th>
              <th className="py-2 font-medium">Created</th>
              <th className="py-2 font-medium">Last used</th>
              <th className="py-2 font-medium"><span className="sr-only">Actions</span></th>
            </tr>
          </thead>
          <tbody>
            {keys.map((key) => (
              <tr key={key.id} className="border-b last:border-0">
                <td className="py-2">
                  <p className="font-medium">{key.name}</p>
                  <p className="readout text-xs text-muted-foreground">{keyPrefix(key)} · {key.kind}</p>
                </td>
                <td className="py-2">
                  <span className="flex flex-wrap gap-1">
                    {key.scopes.map((scope) => <Status key={scope}>{SCOPE_LABELS[scope] ?? scope}</Status>)}
                  </span>
                </td>
                <td className="py-2 text-muted-foreground">{dateFormat.format(new Date(key.pairedAt))}</td>
                <td className="py-2 text-muted-foreground">
                  {key.lastSeenAt ? dateFormat.format(new Date(key.lastSeenAt)) : "never"}
                </td>
                <td className="py-2 text-right">
                  {confirmRevoke === key.id ? (
                    <span className="flex items-center justify-end gap-2">
                      <span className="text-xs text-muted-foreground">Revoke? It stops working immediately.</span>
                      <Button
                        variant="outline"
                        onClick={() => {
                          setConfirmRevoke(null);
                          void revokeApiKeyAction({ clientId: key.id }).then((result) => {
                            if (result.ok) reload();
                            else setError(result.error);
                          });
                        }}
                      >
                        Confirm
                      </Button>
                      <Button variant="ghost" onClick={() => setConfirmRevoke(null)}>Keep</Button>
                    </span>
                  ) : (
                    <Button variant="ghost" onClick={() => setConfirmRevoke(key.id)}>Revoke</Button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <form
        className="grid gap-4 border-t pt-4"
        onSubmit={(event) => {
          event.preventDefault();
          const data = new FormData(event.currentTarget);
          const scopes = data.getAll("scope").map(String);
          setCreating(true);
          void createApiKeyAction({
            name: String(data.get("name") ?? ""),
            kind: String(data.get("kind")) === "machine" ? "machine" : "companion",
            scopes,
          }).then((result) => {
            setCreating(false);
            if (!result.ok) { setError(result.error); return; }
            setShownToken(result.token);
            setCopied(false);
            reload();
            event.currentTarget.reset();
          });
        }}
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Key name">
            <Input required name="name" maxLength={100} placeholder="Chrome companion" autoComplete="off" />
          </Field>
          <Field label="Client kind">
            <select name="kind" className="h-9 rounded-md border border-input bg-background px-3 text-[13px]">
              <option value="companion">Chrome companion</option>
              <option value="machine">Agent or script</option>
            </select>
          </Field>
        </div>
        <fieldset className="flex flex-wrap items-center gap-4 text-[13px]">
          <legend className="sr-only">Scopes</legend>
          {Object.entries(SCOPE_LABELS).map(([scope, label]) => (
            <label key={scope} className="flex items-center gap-2">
              <input type="checkbox" name="scope" value={scope} defaultChecked className="size-4 accent-current" />
              {label}
            </label>
          ))}
        </fieldset>
        <div>
          <Button type="submit" variant="outline" disabled={creating}>{creating ? "Creating…" : "Create API key"}</Button>
        </div>
      </form>

      <Dialog open={shownToken !== null} onOpenChange={(open) => { if (!open) setShownToken(null); }}>
        <DialogContent>
          <DialogTitle>Your new API key</DialogTitle>
          <DialogDescription>
            Shown once. Paste it into the client now — Polymath stores only its digest, so it cannot be shown again.
          </DialogDescription>
          <p className="readout mt-2 break-all rounded-md border border-border bg-muted/60 p-3 text-[13px]">{shownToken}</p>
          <div className="mt-4 flex items-center gap-3">
            <Button
              variant="outline"
              onClick={() => {
                if (!shownToken) return;
                void navigator.clipboard.writeText(shownToken).then(() => setCopied(true));
              }}
            >
              {copied ? "Copied" : "Copy key"}
            </Button>
            <Button variant="ghost" onClick={() => setShownToken(null)}>Done</Button>
          </div>
          <p className="mt-3 text-xs text-muted-foreground">
            Chrome companion: extension → Settings → Access token. It sends this as a bearer token; revoke it here to cut access.
          </p>
        </DialogContent>
      </Dialog>
    </div>
  );
}
