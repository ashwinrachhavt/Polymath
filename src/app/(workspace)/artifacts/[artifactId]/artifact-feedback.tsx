"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { WorkStatus } from "@/components/work-status";
import type { ArtifactRating, LearningArtifactFeedbackTarget } from "@/domains/knowledge/artifact-feedback";
import { rateArtifactAction } from "../feedback-action";

export function ArtifactFeedback({
  target,
  rating,
}: {
  target: LearningArtifactFeedbackTarget;
  rating: ArtifactRating | null;
}) {
  const [selected, setSelected] = useState(rating);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function rate(value: ArtifactRating) {
    setError(null);
    startTransition(async () => {
      const result = await rateArtifactAction({ target, rating: value });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setSelected(result.rating);
    });
  }

  return (
    <section aria-label="Artifact feedback" className="mt-8 border-t border-border pt-4">
      <p className="text-xs text-muted-foreground">Was this useful?</p>
      <div className="mt-2 flex gap-2">
        <Button
          size="sm"
          variant={selected === "helpful" ? "default" : "outline"}
          disabled={pending}
          aria-pressed={selected === "helpful"}
          onClick={() => rate("helpful")}
        >
          Helpful
        </Button>
        <Button
          size="sm"
          variant={selected === "not_helpful" ? "default" : "outline"}
          disabled={pending}
          aria-pressed={selected === "not_helpful"}
          onClick={() => rate("not_helpful")}
        >
          Not helpful
        </Button>
      </div>
      {error ? <WorkStatus state={{ phase: "failed", label: error }} className="mt-2" /> : null}
    </section>
  );
}
