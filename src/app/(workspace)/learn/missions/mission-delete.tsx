"use client";

import { DeleteButton } from "@/components/ui/delete-button";
import type { LiveMissionStatus } from "@/domains/learning/mission-archive";
import { archiveMissionAction, restoreMissionAction } from "../mission-actions";

/* The row's delete: archives the Mission, and the toast's undo puts it back as it was. */
export function MissionDelete({ missionId, status }: { missionId: string; status: LiveMissionStatus }) {
  return (
    <DeleteButton
      label="Delete mission"
      deletedMessage="Mission deleted"
      size="icon-sm"
      onDelete={async () => {
        const result = await archiveMissionAction(missionId);
        if (!result.ok) throw new Error(result.error);
      }}
      undo={async () => {
        const result = await restoreMissionAction(missionId, status);
        if (!result.ok) throw new Error(result.error);
      }}
    />
  );
}
