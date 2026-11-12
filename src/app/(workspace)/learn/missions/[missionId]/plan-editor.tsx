"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { WorkStatus } from "@/components/work-status";
import type { MissionView } from "@/domains/learning/missions";
import { setMissionPlanAction, startMissionAction } from "../../mission-actions";

/*
 * The plan, before the Mission starts: each proposed concept with the passage
 * it came from and the one-line reason, a checkbox to keep it, and a field to
 * add your own. Saving reports what changed; Start freezes the list and leads
 * to the unaided mock.
 */

export function MissionPlanEditor({ mission }: { mission: MissionView }) {
  // Only explicit unchecks are stored; a concept is kept unless the person
  // unticked it. A plan that gained concepts after this rendered still keeps
  // its new ones, rather than silently sending an incomplete keep list.
  const [dropped, setDropped] = useState<Record<string, boolean>>({});
  const [addedText, setAddedText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [started, setStarted] = useState(false);
  const kept = mission.concepts.filter((concept) => !dropped[concept.id]);
  const keptCount = kept.length;
  const added = addedText
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((name) => ({ name }));

  function save(thenStart: boolean) {
    setError(null);
    startTransition(async () => {
      const result = await setMissionPlanAction({
        missionId: mission.id,
        keepConceptIds: kept.map((concept) => concept.conceptId),
        added,
      }).catch(() => ({ ok: false as const, error: "The request did not reach Polymath. Try again." }));
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setAddedText("");
      if (!thenStart) return;
      const startedResult = await startMissionAction(mission.id).catch(() => ({
        ok: false as const,
        error: "The request did not reach Polymath. Try again.",
      }));
      if (!startedResult.ok) {
        setError(startedResult.error);
        return;
      }
      setStarted(true);
      window.location.reload();
    });
  }

  return (
    <div className="flex flex-col gap-3">
      <ul className="flex flex-col gap-2">
        {mission.concepts.map((concept) => (
          <li key={concept.id} className="rounded-lg border border-border p-3">
            <label className="flex items-start gap-2">
              <input
                type="checkbox"
                checked={!dropped[concept.id]}
                onChange={(event) => setDropped((current) => ({ ...current, [concept.id]: !event.target.checked }))}
                disabled={pending}
                className="mt-1 size-3.5"
                aria-label={`Keep ${concept.name}`}
              />
              <span className="min-w-0">
                <span className="block font-medium break-words">{concept.name}</span>
                <span className="mt-0.5 block text-xs text-muted-foreground">{concept.reason}</span>
                {concept.sourceQuote ? (
                  <blockquote className="mt-2 border-l-2 border-border pl-3 text-xs text-muted-foreground">
                    “{concept.sourceQuote}”
                  </blockquote>
                ) : (
                  <span className="mt-1 block text-xs text-muted-foreground">Added by you.</span>
                )}
              </span>
            </label>
          </li>
        ))}
      </ul>

      <label className="flex flex-col gap-1">
        <span className="text-body-dense font-medium">
          Add a concept <span className="text-xs font-normal text-muted-foreground">One per line, optional</span>
        </span>
        <Input
          value={addedText}
          onChange={(event) => setAddedText(event.target.value)}
          placeholder="Write-ahead log"
          aria-label="Add a concept"
          disabled={pending}
        />
      </label>

      {error ? <WorkStatus state={{ phase: "failed", label: error }} /> : null}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs text-muted-foreground">
          {keptCount + added.length === 0
            ? "Keep at least one concept."
            : `${keptCount + added.length} concept${keptCount + added.length === 1 ? "" : "s"} in this Mission.`}
        </p>
        <div className="flex gap-2">
          <Button variant="outline" disabled={pending} onClick={() => save(false)}>
            {pending ? "Saving…" : "Save"}
          </Button>
          <Button disabled={pending || started || keptCount + added.length === 0} onClick={() => save(true)}>
            {started ? "Started" : "Start this Mission"}
          </Button>
        </div>
      </div>
    </div>
  );
}
