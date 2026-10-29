"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { requestJson } from "@/lib/client-request";
import { installBundledSkillAction, removeSkillAction, setSkillEnabledAction } from "./actions";
import type { SkillWriteAction } from "./contract";

/*
 * The three controls a skill row carries. Each returns a typed refusal rather
 * than throwing, so a stale row says so in place instead of blanking the page:
 * a disable on a skill someone removed in another tab reports it and offers a
 * refresh.
 */

function useWrite() {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function run(write: () => Promise<SkillWriteAction>) {
    setError(null);
    start(async () => {
      const result = await write();
      if (!result.ok) {
        setError(result.error);
        return;
      }
      router.refresh();
    });
  }

  return { pending, error, run };
}

export function SkillToggle({ id, name, enabled }: { id: string; name: string; enabled: boolean }) {
  const { pending, error, run } = useWrite();
  return (
    <span className="flex flex-wrap items-center gap-2">
      <Button
        size="sm"
        variant="secondary"
        disabled={pending}
        onClick={() => run(() => setSkillEnabledAction({ id, enabled: !enabled }))}
        aria-label={enabled ? `Disable ${name}` : `Enable ${name}`}
      >
        {pending ? "Saving…" : enabled ? "Disable" : "Enable"}
      </Button>
      {error ? (
        <span role="alert" className="text-destructive text-xs">
          {error}
        </span>
      ) : null}
    </span>
  );
}

export function RemoveSkillButton({ id, name }: { id: string; name: string }) {
  const { pending, error, run } = useWrite();
  const [confirming, setConfirming] = useState(false);
  return (
    <span className="flex flex-wrap items-center gap-2">
      {confirming ? (
        <>
          <Button
            size="sm"
            variant="destructive"
            disabled={pending}
            onClick={() => run(() => removeSkillAction({ id }))}
            aria-label={`Remove ${name}`}
          >
            {pending ? "Removing…" : "Remove"}
          </Button>
          <Button size="sm" variant="ghost" disabled={pending} onClick={() => setConfirming(false)}>
            Keep
          </Button>
        </>
      ) : (
        <Button size="sm" variant="ghost" onClick={() => setConfirming(true)} aria-label={`Remove ${name}`}>
          Remove
        </Button>
      )}
      {error ? (
        <span role="alert" className="text-destructive text-xs">
          {error}
        </span>
      ) : null}
    </span>
  );
}

export function InstallExample({ slug, installed }: { slug: string; installed: boolean }) {
  const { pending, error, run } = useWrite();
  if (installed) {
    return (
      <span role="status" className="text-muted-foreground text-xs">
        Installed
      </span>
    );
  }
  return (
    <span className="flex flex-wrap items-center gap-2">
      <Button
        size="sm"
        variant="secondary"
        disabled={pending}
        onClick={() => run(() => installBundledSkillAction({ slug }))}
      >
        {pending ? "Installing…" : "Install"}
      </Button>
      {error ? (
        <span role="alert" className="text-destructive text-xs">
          {error}
        </span>
      ) : null}
    </span>
  );
}

/**
 * The one action a skill row exists for: run it. This posts to the existing
 * /api/v1/runs with the skill id, exactly as the Assist composer does; there is
 * no second run path.
 */
export function UseSkill({ id, name, disabled }: { id: string; name: string; disabled: boolean }) {
  const [objective, setObjective] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  async function start() {
    setPending(true);
    setError(null);
    const result = await requestRun(objective, id);
    setPending(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setObjective("");
    router.refresh();
    // The run appears in Assistant's recent runs; that is where its progress,
    // questions, and spend are, so this is where the person needs to be.
    router.push("/polymath");
  }

  if (disabled) {
    return (
      <p className="text-muted-foreground text-xs">
        Enable this skill to use it.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2">
        <input
          value={objective}
          onChange={(event) => setObjective(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && objective.trim() && !pending) start();
          }}
          placeholder="Describe what to do with this skill."
          aria-label={`Objective for ${name}`}
          className="border-input bg-background focus-visible:ring-ring w-full rounded-md border px-3 py-1.5 text-[13px] outline-none focus-visible:ring-3"
        />
        <Button onClick={start} disabled={pending || objective.trim().length === 0} size="sm">
          {pending ? "Starting…" : "Use skill"}
        </Button>
      </div>
      {error ? (
        <p role="alert" className="text-destructive text-xs">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/*
 * The run start is a plain fetch through `requestJson`, the one client request
 * path, so a 404 (skill removed elsewhere) and a 503 (bridge down) each report
 * what happened instead of a status number.
 */
async function requestRun(
  objective: string,
  skillId: string,
): Promise<{ ok: true; runId: string } | { ok: false; error: string }> {
  const result = await requestJson<{ runId: string }>("/api/v1/runs", {
    method: "POST",
    body: { objective, skillId },
    idempotencyKey: crypto.randomUUID(),
  });
  return result.ok ? { ok: true, runId: result.data.runId } : { ok: false, error: result.failure.title };
}
