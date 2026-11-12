"use client";

import { useRouter } from "next/navigation";
import { useRef, useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { WorkStatus } from "@/components/work-status";
import type { MissionView } from "@/domains/learning/missions";
import { startMockAction } from "./mock-actions";

/**
 * Starts an unaided sitting and returns at once; the Mission page shows the
 * questions being written and then the first one. A resend of the same click
 * replays its key, so a double-click opens one sitting.
 */
export function MockInterview({ mission }: { mission: MissionView }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const request = useRef<string | null>(null);

  function start() {
    setError(null);
    request.current ??= crypto.randomUUID();
    const requestKey = request.current;
    startTransition(async () => {
      const result = await startMockAction({ missionId: mission.id, requestKey }).catch(() => ({
        ok: false as const,
        error: "The request did not reach Polymath. Try again.",
      }));
      if (!result.ok) {
        setError(result.error);
        return;
      }
      request.current = null;
      router.push(`/learn/missions/${mission.id}/mock`);
    });
  }

  return (
    <section className="panel rounded-xl p-4">
      <h2 className="font-medium">Mock interview</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        {mission.concepts.length} question{mission.concepts.length === 1 ? "" : "s"}, one per concept, answered from
        memory. No hints and nothing revealed until you submit. Your answers are saved exactly as you write them.
      </p>
      {error ? <WorkStatus state={{ phase: "failed", label: error }} /> : null}
      <Button className="mt-3" disabled={pending} onClick={start}>
        {pending ? "Starting…" : "Start the mock interview"}
      </Button>
    </section>
  );
}
