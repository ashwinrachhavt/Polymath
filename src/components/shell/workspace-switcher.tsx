"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { Popover } from "radix-ui";
import { Check, ChevronsUpDown, Mail, Plus } from "lucide-react";
import { cn } from "cn";
import { switchWorkspaceAction } from "@/app/(workspace)/settings/workspaces/actions";
import { Badge } from "@/components/ui/badge";
import { Tooltip } from "@/components/ui/tooltip";
import type { SwitchableWorkspace } from "@/domains/identity/resolve";

/*
 * The workspace switcher (tenancy activation, spec D2), mounted at the top of
 * the rail: the workspace is the root of where-you-are. Radix Popover per
 * the account menu — focus trap, escape, and focus return come from the
 * primitive, not hand-rolled here.
 *
 * Rows are the memberships the layout resolved server-side — the same list
 * resolution selects among, so the popover can offer nothing the membership
 * table disagrees with. Selecting one posts switchWorkspaceAction, which
 * re-proves the membership in the database, moves the per-device cookie, and
 * flushes the shell for the new context; the refreshed layout props move the
 * check and rename the trigger, so the component only closes and shows an
 * error when the action refuses.
 *
 * A pending invitation row is informational on purpose: the raw token exists
 * only in the link the inviter shared, so nothing here can accept it. It
 * names the workspace and says how to join.
 */

export type WorkspaceSwitcherData = {
  currentWorkspaceId: string;
  memberships: SwitchableWorkspace[];
  pendingInvitations: { workspaceId: string; workspaceName: string; role: string }[];
};

export function WorkspaceSwitcher({ data, rail = false }: { data: WorkspaceSwitcherData | null; rail?: boolean }) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  // The keyless anonymous shell (no session behind it) has no workspace
  // context to switch, so the switcher is absent rather than empty.
  if (!data) return null;

  const current = data.memberships.find((membership) => membership.workspaceId === data.currentWorkspaceId);
  const label = current?.name ?? "Workspace";

  const switchTo = (workspaceId: string) => {
    setError(null);
    startTransition(async () => {
      const result = await switchWorkspaceAction({ workspaceId });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setOpen(false);
    });
  };

  return (
    <Popover.Root
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setError(null);
      }}
    >
      <Tooltip content="Switch workspace">
        <Popover.Trigger asChild>
          <button
            type="button"
            aria-label={`Switch workspace, currently ${label}`}
            className={cn(
              "hover:bg-muted focus-visible:ring-ring flex h-8 min-w-0 items-center gap-1.5 rounded-md px-2 outline-none",
              "focus-visible:ring-3 data-[state=open]:bg-muted data-[state=open]:text-foreground",
              // In the rail the trigger fills the row, so its label has the width of the rail.
              rail && "hover:bg-sidebar-accent data-[state=open]:bg-sidebar-accent flex-1",
            )}
          >
            <span
              className={cn(
                "truncate text-body-dense font-medium",
                rail ? "min-w-0 flex-1 text-left" : "max-w-[140px]",
              )}
            >
              {label}
            </span>
            <ChevronsUpDown aria-hidden className="text-muted-foreground size-3.5 shrink-0" />
          </button>
        </Popover.Trigger>
      </Tooltip>

      <Popover.Portal>
        <Popover.Content
          aria-label="Workspaces"
          align="start"
          sideOffset={6}
          className="panel bg-popover text-popover-foreground shadow-raised z-50 w-72 rounded-xl p-2 outline-none"
        >
          <p className="text-muted-foreground px-2 pt-1 pb-2 text-data font-medium">Workspaces</p>
          <div className="flex flex-col gap-0.5">
            {data.memberships.map((membership) => {
              const isCurrent = membership.workspaceId === data.currentWorkspaceId;
              return (
                <button
                  key={membership.workspaceId}
                  type="button"
                  disabled={pending}
                  aria-current={isCurrent ? "true" : undefined}
                  onClick={() => {
                    // Switching to the workspace you are in is a close, not
                    // a server round that rewrites the same cookie.
                    if (isCurrent) {
                      setOpen(false);
                      return;
                    }
                    switchTo(membership.workspaceId);
                  }}
                  className="hover:bg-accent focus-visible:ring-ring flex h-9 w-full items-center gap-2 rounded-md px-2 text-left text-body-dense outline-none focus-visible:ring-3 disabled:opacity-50"
                >
                  <span className="min-w-0 flex-1 truncate">{membership.name}</span>
                  <Badge variant="secondary" className="shrink-0">
                    {membership.role}
                  </Badge>
                  <Check aria-hidden className={cn("text-app-accent size-4 shrink-0", !isCurrent && "opacity-0")} />
                </button>
              );
            })}
          </div>

          {data.pendingInvitations.length > 0 ? (
            <div className="mt-1 flex flex-col gap-0.5">
              <div aria-hidden className="bg-border my-1 h-px" />
              {data.pendingInvitations.map((invitation) => (
                <div
                  key={invitation.workspaceId}
                  className="flex h-9 items-center gap-2 rounded-md px-2 text-body-dense"
                >
                  <Mail aria-hidden className="size-4 shrink-0 opacity-70" />
                  <span className="min-w-0 flex-1 truncate">Invited to {invitation.workspaceName}</span>
                  <Badge variant="outline" className="shrink-0">
                    {invitation.role}
                  </Badge>
                </div>
              ))}
              <p className="text-muted-foreground px-2 pb-1 text-data">
                Open the invitation link you were sent to join.
              </p>
            </div>
          ) : null}

          <div aria-hidden className="bg-border my-1 h-px" />
          <Link
            href="/workspaces/create"
            onClick={() => setOpen(false)}
            className="hover:bg-accent focus-visible:ring-ring flex h-9 w-full items-center gap-2 rounded-md px-2 text-body-dense outline-none focus-visible:ring-3"
          >
            <Plus aria-hidden className="size-4 shrink-0 opacity-70" />
            Create workspace
          </Link>

          {error ? (
            <p role="alert" className="text-destructive px-2 pt-1 text-xs">
              {error}
            </p>
          ) : null}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
