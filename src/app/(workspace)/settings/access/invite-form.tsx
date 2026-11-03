"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Field } from "@/components/workspace/ui";
import { createInvitationAction } from "../actions";

/*
 * The invite slice of the Access console (spec D4). The action returns the
 * raw token exactly once - only its digest is stored - so the link is shown
 * here for the admin to copy, and never again after leaving this state.
 */
export function InviteForm() {
  const [error, setError] = useState<string | null>(null);
  const [inviteLink, setInviteLink] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  return (
    <form
      className="grid gap-3 sm:grid-cols-[1fr_auto_auto] sm:items-end"
      onSubmit={(event) => {
        event.preventDefault();
        const form = event.currentTarget;
        const data = new FormData(form);
        setError(null);
        setInviteLink(null);
        startTransition(async () => {
          const result = await createInvitationAction({
            email: String(data.get("email") || ""),
            role: String(data.get("role") || "member"),
          });
          if (!result.ok) {
            setError(result.error);
            return;
          }
          setInviteLink(`${window.location.origin}${result.invitePath}`);
          form.reset();
        });
      }}
    >
      <Field label="Email">
        <Input name="email" type="email" required maxLength={254} placeholder="someone@example.com" />
      </Field>
      <Field label="Role">
        <Select name="role" className="min-w-32" defaultValue="member">
          <option value="member">Member</option>
          <option value="admin">Admin</option>
          <option value="viewer">Viewer</option>
        </Select>
      </Field>
      <Button type="submit" variant="outline" disabled={pending}>
        {pending ? "Inviting…" : "Invite"}
      </Button>
      {error ? (
        <p className="text-destructive text-[13px] sm:col-span-3" role="alert">
          {error}
        </p>
      ) : null}
      {inviteLink ? (
        <div
          className="sm:col-span-3 rounded-lg border border-border bg-muted/40 p-3 text-[13px]"
          role="status"
          data-testid="invite-link"
        >
          <p className="font-medium">Share this invitation link - it is shown once.</p>
          <p className="mt-1 break-all font-mono text-xs text-muted-foreground" data-testid="invite-link-url">
            {inviteLink}
          </p>
          <Button
            type="button"
            variant="outline"
            className="mt-2"
            onClick={() => {
              void navigator.clipboard.writeText(inviteLink);
            }}
          >
            Copy link
          </Button>
        </div>
      ) : null}
    </form>
  );
}
