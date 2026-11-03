"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { changeMemberRoleAction, leaveWorkspaceAction, removeMemberAction } from "@/app/(workspace)/settings/actions";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Select } from "@/components/ui/select";
import { Status } from "@/components/workspace/ui";
import { useWorkspace } from "@/components/workspace/workspace-provider";
import type { MemberRow } from "@/domains/identity/members";

/*
 * The working half of the Access console (D5). The matrix the domain enforces
 * in changeMembership, rendered: admins manage non-owner rows, owners manage
 * every row, and the one control a sole owner cannot use — their own role —
 * is disabled with the reason rather than hidden, because the block is a fact
 * about the workspace, not an absence of permission. Leaving replaces Remove
 * on the caller's own row: same state machine, self-service verb.
 */

const dateFormat = new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeZone: "UTC" });

type Caller = { userId: string; role: "owner" | "admin" | "member" | "viewer" };

function RoleSelect({ row, caller, soleOwner }: { row: MemberRow; caller: Caller; soleOwner: boolean }) {
  const { notify } = useWorkspace();
  const router = useRouter();
  const [saving, setSaving] = useState(false);

  const owner = caller.role === "owner";
  const ownSoleOwnerRow = row.userId === caller.userId && row.role === "owner" && soleOwner;
  const roles: string[] = owner ? ["owner", "admin", "member", "viewer"] : ["admin", "member", "viewer"];

  return (
    <Select
      aria-label={`Role for ${row.displayName ?? row.email ?? "member"}`}
      variant="ghost"
      className="h-8 text-[13px]"
      value={row.role}
      disabled={saving || ownSoleOwnerRow}
      title={ownSoleOwnerRow ? "A workspace needs at least one active owner." : undefined}
      onChange={(event) => {
        const role = event.target.value;
        setSaving(true);
        void changeMemberRoleAction({ membershipId: row.membershipId, role }).then((result) => {
          setSaving(false);
          if (!result.ok) {
            notify(result.error);
          }
          // Refresh on success and on failure: the failure path snaps the
          // select back to the persisted role the re-render carries.
          router.refresh();
        });
      }}
    >
      {roles.map((role) => (
        <option key={role} value={role}>
          {role}
        </option>
      ))}
    </Select>
  );
}

function RemoveMember({ row }: { row: MemberRow }) {
  const { notify } = useWorkspace();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const name = row.displayName ?? row.email ?? "this member";

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="ghost" size="sm" className="h-8 text-[13px] text-muted-foreground">
          Remove
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogTitle>Remove {name} from this workspace?</DialogTitle>
        <DialogDescription>
          Their membership ends and they keep nothing here. A new invitation is the way back in.
        </DialogDescription>
        <div className="flex justify-end gap-2">
          <Button variant="outline" size="sm" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button
            size="sm"
            disabled={saving}
            onClick={() => {
              setSaving(true);
              void removeMemberAction({ membershipId: row.membershipId }).then((result) => {
                setSaving(false);
                setOpen(false);
                if (!result.ok) {
                  notify(result.error);
                  return;
                }
                notify(`${name} no longer has access.`);
                router.refresh();
              });
            }}
          >
            {saving ? "Removing…" : "Remove member"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function LeaveWorkspace() {
  const { notify } = useWorkspace();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="ghost" size="sm" className="h-8 text-[13px] text-muted-foreground">
          Leave
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogTitle>Leave this workspace?</DialogTitle>
        <DialogDescription>You lose access to everything in it. A new invitation is the way back in.</DialogDescription>
        <div className="flex justify-end gap-2">
          <Button variant="outline" size="sm" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button
            size="sm"
            disabled={saving}
            onClick={() => {
              setSaving(true);
              void leaveWorkspaceAction().then((result) => {
                setSaving(false);
                setOpen(false);
                if (!result.ok) {
                  // The sole owner's leave lands here: the domain refuses to
                  // strand a workspace without an active owner.
                  notify(result.error);
                  return;
                }
                router.push("/");
              });
            }}
          >
            {saving ? "Leaving…" : "Leave workspace"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function MembersTable({
  members,
  caller,
  soleOwner,
}: {
  members: MemberRow[];
  caller: Caller;
  soleOwner: boolean;
}) {
  const canManage = caller.role === "owner" || caller.role === "admin";
  return (
    <table className="w-full text-[13px]">
      <thead>
        <tr className="border-b text-left text-xs text-muted-foreground">
          <th className="py-2 font-medium">Member</th>
          <th className="py-2 font-medium">Role</th>
          <th className="py-2 font-medium">Status</th>
          <th className="py-2 font-medium">Since</th>
          {canManage && (
            <th className="py-2 font-medium">
              <span className="sr-only">Actions</span>
            </th>
          )}
        </tr>
      </thead>
      <tbody>
        {members.map((m) => {
          // An owner row answers to owners only — the domain refuses admin
          // writes on it, so the console does not offer them.
          const manageable = canManage && (caller.role === "owner" || m.role !== "owner");
          const own = m.userId === caller.userId;
          const active = m.status === "active";
          return (
            <tr key={m.membershipId} className="border-b last:border-0">
              <td className="py-2">
                <p className="font-medium">
                  {m.displayName ?? m.email ?? "Unnamed member"}
                  {own && <span className="ml-2 text-xs font-normal text-muted-foreground">you</span>}
                </p>
                {m.displayName && m.email && <p className="text-xs text-muted-foreground">{m.email}</p>}
              </td>
              <td className="py-2 capitalize">
                {manageable && active ? <RoleSelect row={m} caller={caller} soleOwner={soleOwner} /> : m.role}
              </td>
              <td className="py-2">
                <Status>{m.status}</Status>
              </td>
              <td className="py-2 text-muted-foreground">{dateFormat.format(m.since)}</td>
              {canManage && (
                <td className="py-2 text-right">
                  {own ? active && <LeaveWorkspace /> : manageable && active && <RemoveMember row={m} />}
                </td>
              )}
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
