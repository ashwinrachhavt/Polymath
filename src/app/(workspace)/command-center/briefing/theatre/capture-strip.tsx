"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { scheduleCaptureAction } from "./actions";

/*
 * The theatre's capture strip (ASH-308): what arrived today, as chips. Drag a
 * chip onto an hour slot to plan it (the timeline owns the drop); on a touch
 * viewport the tap fallback opens the same choice as a plain hour picker.
 * The strip never mutates the inbox - scheduling creates a session that
 * points at the capture.
 */
export type CaptureChip = {
  id: string;
  title: string | null;
  text: string | null;
  url: string | null;
  processingState: string;
  createdAt: string;
};

export function CaptureStrip({ captures }: { captures: CaptureChip[] }) {
  const router = useRouter();
  const [picking, setPicking] = useState<string | null>(null);

  const label = (chip: CaptureChip) => chip.title ?? chip.text?.slice(0, 60) ?? chip.url ?? "Capture";

  const pick = async (chipId: string, hour: number) => {
    const slot = new Date();
    slot.setMinutes(0, 0, 0);
    slot.setHours(hour);
    const result = await scheduleCaptureAction({ captureId: chipId, scheduledAt: slot.toISOString(), idempotencyKey: crypto.randomUUID() });
    if (result.ok) router.refresh();
    setPicking(null);
  };

  if (captures.length === 0) {
    return <p className="text-[12px] text-muted-foreground">Nothing captured yet today. Drop a capture on a slot to plan it.</p>;
  }

  return (
    <div className="flex flex-wrap items-center gap-2" data-testid="capture-strip">
      {captures.map((chip) => (
        <div key={chip.id} className="relative">
          <button
            type="button"
            draggable
            onDragStart={(event) => {
              event.dataTransfer.setData("application/x-capture-id", chip.id);
              event.dataTransfer.effectAllowed = "copy";
            }}
            onClick={() => setPicking(picking === chip.id ? null : chip.id)}
            className="max-w-56 cursor-grab truncate rounded-full border border-border bg-muted/50 px-3 py-1.5 text-[12px] font-medium hover:bg-muted active:cursor-grabbing"
            data-testid={`capture-chip-${chip.id}`}
            title={label(chip)}
          >
            {label(chip)}
          </button>
          {picking === chip.id ? (
            <div className="absolute top-full left-0 z-20 mt-1 w-44 rounded-md border border-border bg-background p-2 shadow-md" role="menu">
              <p className="mb-1 text-[11px] font-medium text-muted-foreground">Plan it for…</p>
              <div className="grid grid-cols-4 gap-1">
                {Array.from({ length: 12 }, (_, i) => i + 8).map((hour) => (
                  <button
                    key={hour}
                    type="button"
                    role="menuitem"
                    className="rounded px-1 py-1 text-[11px] hover:bg-muted"
                    onClick={() => void pick(chip.id, hour)}
                  >
                    {String(hour).padStart(2, "0")}:00
                  </button>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      ))}
    </div>
  );
}
