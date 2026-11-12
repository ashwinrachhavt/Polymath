"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { PencilIcon } from "lucide-react";

import { ArchiveArtifactButton } from "@/app/(workspace)/artifacts/archive-button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { IconButton } from "@/components/ui/icon-button";
import { IdeaEditor } from "@/components/polymath/zettels/idea-editor";

/*
 * The idea card as a modal over the Ideas collection (the Alfred pattern).
 * The page opens it by navigating to `?idea=<id>`, so opening is a
 * navigation and the browser's back button closes it; closing from inside
 * (X, Escape, overlay) replaces the parameter out of the URL so the list
 * keeps its filters. The edit button sits top right, beside the dialog's
 * close button, and swaps the card for the editor in place — the editor
 * keeps its own autosave and version-conflict machinery. Delete sits beside
 * it: two clicks archive the idea and close the card, and the toast's Undo
 * puts it back in the list.
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
      <DialogContent
        aria-describedby={undefined}
        className="max-h-[85dvh] gap-4 overflow-y-auto sm:max-w-xl"
        // Open on the card, not on its first control: landing on Delete would
        // put one Enter between opening an idea and arming its removal.
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          (event.currentTarget as HTMLElement).focus();
        }}
      >
        {editor ? (
          <div className="absolute top-2 right-10 flex items-center gap-0.5">
            <ArchiveArtifactButton artifactId={editor.artifactId} noun="idea" leaveTo={closeHref} />
            <IconButton
              label={editing ? "Done editing" : "Edit idea"}
              icon={<PencilIcon aria-hidden />}
              size="icon-sm"
              aria-pressed={editing}
              onClick={() => setEditing((value) => !value)}
            />
          </div>
        ) : null}
        <DialogTitle className="pr-24 text-lg leading-snug font-medium">{title}</DialogTitle>
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
