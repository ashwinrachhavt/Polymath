"use client";

import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import type { BrowserRow } from "@/domains/knowledge/file-browser";

/*
 * Share and permissions, as a surface only. Axiom has no sharing backend and
 * sends nothing, so every control here is disabled and the dialog says so
 * plainly. What is real: who can open these documents today (the workspace
 * members, by their role) and a copy of the in-app link, which only works for
 * a signed-in member.
 */
export function ShareDialog({
  open,
  onOpenChange,
  rows,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  rows: BrowserRow[];
}) {
  const single = rows.length === 1 ? rows[0]! : null;
  const label = single ? single.title : `${rows.length} documents`;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="font-display text-xl font-normal">Share {label}</DialogTitle>
          <DialogDescription>Sharing with other people is not available yet. Nothing here sends anything.</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3 text-[13px]">
          <div className="flex gap-2">
            <input
              disabled
              placeholder="Add people by email"
              aria-label="Add people by email"
              className="border-input bg-background h-9 min-w-0 flex-1 rounded-md border px-2 text-[13px] opacity-50"
            />
            <Select disabled aria-label="Permission" className="w-28">
              <option>Can view</option>
              <option>Can comment</option>
              <option>Can edit</option>
            </Select>
          </div>
          <div className="border-border rounded-md border p-3">
            <p className="font-medium">Who can open this today</p>
            <p className="text-muted-foreground mt-1 text-xs">
              Members of this workspace, by role: viewers read, members read and review, admins and owners manage.
            </p>
          </div>
          {single ? (
            <Button
              type="button"
              variant="outline"
              onClick={() => void navigator.clipboard.writeText(`${window.location.origin}/alfred/library/${single.id}`)}
            >
              Copy link for workspace members
            </Button>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}
