"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { createCustomSpecialistAction, installSpecialistAction } from "./actions";

/*
 * The page's three mutations, as small client islands on a server-rendered
 * page: install a roster role, define a custom specialist, hire a profile
 * onto a run. Hiring posts to /api/v1/runs — the same engine path as Alfred's
 * own runs, so budget reservation and policy freeze are identical.
 */

export function InstallButton({ slug, installed }: { slug: string; installed: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  if (installed) {
    return (
      <span className="text-muted-foreground text-xs" role="status">
        On your bench
      </span>
    );
  }
  return (
    <span className="flex items-center gap-2">
      <Button
        variant="secondary"
        disabled={pending}
        onClick={() =>
          start(async () => {
            setError(null);
            try {
              await installSpecialistAction({ slug });
              router.refresh();
            } catch (cause) {
              setError(cause instanceof Error ? cause.message : "Install failed.");
            }
          })
        }
      >
        {pending ? "Adding…" : "Add to bench"}
      </Button>
      {error ? <span className="text-destructive text-xs">{error}</span> : null}
    </span>
  );
}

export function HireForm({ profileName, disabled }: { profileName: string; disabled: boolean }) {
  const router = useRouter();
  const [objective, setObjective] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function hire() {
    setPending(true);
    setError(null);
    try {
      const response = await fetch("/api/v1/runs", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
        body: JSON.stringify({ objective, profileName }),
      });
      if (!response.ok) {
        const problem = (await response.json().catch(() => null)) as { title?: string } | null;
        throw new Error(problem?.title ?? `Run failed to start (${response.status}).`);
      }
      setObjective("");
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Run failed to start.");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <input
          value={objective}
          onChange={(event) => setObjective(event.target.value)}
          placeholder="Give this specialist an objective."
          aria-label={`Objective for ${profileName}`}
          className="border-input bg-background focus-visible:ring-ring w-full rounded-md border px-3 py-1.5 text-[13px] outline-none focus-visible:ring-3"
        />
        <Button onClick={hire} disabled={pending || disabled || objective.trim().length === 0}>
          {pending ? "Hiring…" : "Hire"}
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

const TOOL_CHOICES = ["tasks.read", "documents.search", "web.search", "web.fetch", "gmail.send"] as const;

export function CreateSpecialistForm() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [mission, setMission] = useState("");
  const [instructions, setInstructions] = useState("");
  const [tools, setTools] = useState<string[]>(["tasks.read", "documents.search", "web.search", "web.fetch"]);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function toggle(tool: string) {
    setTools((current) => (current.includes(tool) ? current.filter((t) => t !== tool) : [...current, tool]));
  }

  async function create() {
    setPending(true);
    setError(null);
    try {
      await createCustomSpecialistAction({ name, mission, instructions, allowedTools: tools });
      setName("");
      setMission("");
      setInstructions("");
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not create the specialist.");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="grid gap-3 md:grid-cols-2">
        <input
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="Name, e.g. Launch Copywriter"
          aria-label="Specialist name"
          className="border-input bg-background focus-visible:ring-ring rounded-md border px-3 py-1.5 text-[13px] outline-none focus-visible:ring-3"
        />
        <input
          value={mission}
          onChange={(event) => setMission(event.target.value)}
          placeholder="One line: what this specialist is for."
          aria-label="Mission"
          className="border-input bg-background focus-visible:ring-ring rounded-md border px-3 py-1.5 text-[13px] outline-none focus-visible:ring-3"
        />
      </div>
      <textarea
        value={instructions}
        onChange={(event) => setInstructions(event.target.value)}
        rows={4}
        placeholder="The brief it is held to: specialty, stance, and limits. Consequential external actions become proposals either way."
        aria-label="Brief"
        className="border-input bg-background focus-visible:ring-ring w-full resize-y rounded-md border px-3 py-2 text-[13px] outline-none focus-visible:ring-3"
      />
      <fieldset className="flex flex-wrap items-center gap-3">
        <legend className="sr-only">Tool scope</legend>
        {TOOL_CHOICES.map((tool) => (
          <label key={tool} className="flex items-center gap-1.5 text-xs">
            <input type="checkbox" checked={tools.includes(tool)} onChange={() => toggle(tool)} />
            <code>{tool}</code>
          </label>
        ))}
      </fieldset>
      <Button onClick={create} disabled={pending || name.trim().length === 0 || instructions.trim().length === 0} className="w-fit">
        {pending ? "Creating…" : "Create specialist"}
      </Button>
      {error ? (
        <p role="alert" className="text-destructive text-xs">
          {error}
        </p>
      ) : null}
    </div>
  );
}
