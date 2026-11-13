"use client";

import { useRouter } from "next/navigation";
import { DeleteButton } from "@/components/ui/delete-button";
import { archiveArtifactAction, restoreArtifactAction } from "./archive-actions";

/*
 * Delete for one idea or generated artifact: the shared two-click button,
 * archiving on confirm with Undo in the toast. Used on the Ideas cards and
 * card modal and on the Artifacts gallery and detail page, so the four places
 * cannot drift apart.
 */
export function ArchiveArtifactButton({
  artifactId,
  noun,
  leaveTo,
  className,
}: {
  artifactId: string;
  /** "idea", "artifact": names the button and the toast. */
  noun: string;
  /** Where to go after archiving, when the current view showed only this item (a card modal, a detail page). */
  leaveTo?: string;
  className?: string;
}) {
  const router = useRouter();
  return (
    <DeleteButton
      label={`Delete ${noun}`}
      size="icon-sm"
      className={className}
      deletedMessage={`${noun[0].toUpperCase()}${noun.slice(1)} deleted`}
      onDelete={async () => {
        const result = await archiveArtifactAction({ artifactId });
        if (!result.ok) throw new Error(result.error);
        if (leaveTo) router.replace(leaveTo);
      }}
      undo={async () => {
        const result = await restoreArtifactAction({ artifactId });
        if (!result.ok) throw new Error(result.error);
      }}
    />
  );
}
