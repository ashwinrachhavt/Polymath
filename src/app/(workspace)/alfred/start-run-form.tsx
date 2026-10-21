"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { requestJson } from "@/lib/client-request";
import { SkillPicker, type PickableSkill } from "./skills/skill-picker";

/*
 * The one mutation on this page: an objective becomes a run. The POST goes to
 * /api/v1/runs, whose engine claims the budget before the session starts.
 * On success the router refresh lands the new run in the server-rendered list.
 * The idempotency key makes a browser retry or a double-submit start one run.
 *
 * The skill picker is the same field the Skills page posts: at most one skill
 * is pinned per run, and the pin is frozen into the run's policy snapshot.
 */
export function StartRunForm({
  dossiers = [],
  skills = [],
}: {
  dossiers?: Array<{ id: string; title: string }>;
  skills?: PickableSkill[];
}) {
  const router = useRouter();
  const [objective, setObjective] = useState("");
  const [dossierId, setDossierId] = useState("");
  const [skillId, setSkillId] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function start() {
    setPending(true);
    setError(null);
    const result = await requestJson<{ runId: string }>("/api/v1/runs", {
      method: "POST",
      body: {
        objective,
        ...(dossierId ? { dossierId } : {}),
        ...(skillId ? { skillId } : {}),
      },
      idempotencyKey: crypto.randomUUID(),
    });
    setPending(false);
    if (!result.ok) {
      setError(result.failure.title);
      return;
    }
    setObjective("");
    router.refresh();
  }

  return (
    <div className="flex flex-col gap-3">
      <label htmlFor="objective" className="sr-only">
        What should the assistant do?
      </label>
      <textarea
        id="objective"
        rows={3}
        value={objective}
        onChange={(event) => setObjective(event.target.value)}
        placeholder={
          skillId
            ? "Describe what to do with this skill."
            : "Describe an objective. Polymath proposes; you approve anything that leaves Polymath."
        }
        className="border-input bg-background focus-visible:ring-ring w-full resize-y rounded-md border px-3 py-2 text-[13px] outline-none focus-visible:ring-3"
      />
      <div className="flex flex-wrap items-center gap-3">
        <SkillPicker skills={skills} value={skillId} onChange={setSkillId} />
        {dossiers.length > 0 ? (
          <div className="flex items-center gap-2">
            <label htmlFor="dossier" className="text-muted-foreground text-xs">Search only in</label>
            <Select id="dossier" value={dossierId} onChange={(event) => setDossierId(event.target.value)}
              className="border-input bg-background rounded-md border px-2 py-1 text-xs"
            >
              <option value="">All documents</option>
              {dossiers.map((d) => (
                <option key={d.id} value={d.id}>{d.title}</option>
              ))}
            </Select>
          </div>
        ) : null}
      </div>
      <Button onClick={start} disabled={pending || objective.trim().length === 0} className="w-fit">
        {pending ? "Starting…" : "Start a run"}
      </Button>
      {error ? (
        <p role="alert" className="text-destructive text-xs">
          {error}
        </p>
      ) : null}
    </div>
  );
}
