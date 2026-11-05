"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { PencilIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { IdeaEditor } from "@/components/polymath/zettels/idea-editor";

/*
 * The idea card as a modal over the Ideas collection (the Alfred pattern).
 * The page opens it by navigating to `?idea=<id>`, so opening is a
 * navigation and the browser's back button closes it; closing from inside
 * (X, Escape, overlay) replaces the parameter out of the URL so the list
 * keeps its filters. The edit button sits top right, beside the dialog's
 * close button, and swaps the card for the editor in place — the editor
 * keeps its own autosave and version-conflict machinery.
 */

export type IdeaModalEditor = {
  workspaceId: string;
  artifactId: string;
  version: number;
  initialContent?: unknown;
};

export function IdeaModal({
  title,
  closeHref,
  editor,
  children,
}: {
  title: string;
  closeHref: string;
  /** Null only for the not-found state — there is no card to edit. */
  editor: IdeaModalEditor | null;
  children: React.ReactNode;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(true);
  const [editing, setEditing] = useState(false);
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) router.replace(closeHref);
      }}
    >
      <DialogContent aria-describedby={undefined} className="max-h-[85dvh] gap-4 overflow-y-auto sm:max-w-xl">
        {editor ? (
          <Button
            variant="ghost"
            size="icon-sm"
            className="absolute top-2 right-10"
            aria-label={editing ? "Done editing" : "Edit idea"}
            aria-pressed={editing}
            onClick={() => setEditing((value) => !value)}
          >
            <PencilIcon />
          </Button>
        ) : null}
        <DialogTitle className="pr-16 text-lg leading-snug font-medium">{title}</DialogTitle>
        {editor && editing ? (
          <IdeaEditor
            workspaceId={editor.workspaceId}
            artifactId={editor.artifactId}
            version={editor.version}
            initialContent={editor.initialContent}
            label={null}
          />
        ) : (
          <div className="flex flex-col gap-4">{children}</div>
        )}
      </DialogContent>
    </Dialog>
  );
}
