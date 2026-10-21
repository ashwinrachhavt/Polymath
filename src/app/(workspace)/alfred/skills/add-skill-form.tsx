"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { inspectSkillAction, installSkillAction } from "./actions";
import type { DiscoveredSkill, InspectAction } from "./contract";

/*
 * Two steps, one island. Inspect reads the source and shows what was found;
 * install re-reads the same revision on the server and writes the row. The
 * client holds only what the person is looking at: the text they pasted and
 * the discovery the action returned. Nothing is staged server-side between the
 * two calls, so a reload or a second tab cannot install something unseen.
 */

type Found = Extract<InspectAction, { ok: true }>;

/** The input the discovery was read from, kept so an edit after Inspect cannot install something else. */
type Inspected = Found & { source: string };

export function AddSkillForm() {
  const router = useRouter();
  const [source, setSource] = useState("");
  const [found, setFound] = useState<Inspected | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [installed, setInstalled] = useState<Set<string>>(new Set());
  const [inspecting, startInspect] = useTransition();
  const [installing, setInstalling] = useState<string | null>(null);

  function inspect() {
    setError(null);
    setFound(null);
    setInstalled(new Set());
    const inspectedSource = source;
    startInspect(async () => {
      const result = await inspectSkillAction({ source: inspectedSource });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setFound({ ...result, source: inspectedSource });
    });
  }

  async function install(skill: DiscoveredSkill) {
    if (!found) return;
    setInstalling(skill.slug);
    setError(null);
    const result = await installSkillAction({
      source: found.source,
      sourcePath: skill.sourcePath,
      revision: found.revision,
    });
    setInstalling(null);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setInstalled((current) => new Set(current).add(skill.slug));
    router.refresh();
  }

  return (
    <div className="flex flex-col gap-3">
      <form
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (source.trim() && !inspecting) inspect();
        }}
      >
        <div className="flex flex-col gap-1.5">
          <label htmlFor="skill-source" className="text-[13px] font-medium">
            Source
          </label>
          <Input
            id="skill-source"
            value={source}
            onChange={(event) => setSource(event.target.value)}
            placeholder="github.com/owner/repo, npx skills add owner/repo, or ~/Projects/my-skill"
            className="text-[13px]"
            aria-describedby="skill-source-hint"
          />
          <p id="skill-source-hint" className="text-muted-foreground text-xs">
            A github.com link, a supported install command, or a folder under your skills root.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <Button type="submit" variant="secondary" disabled={inspecting || source.trim().length === 0}>
            {inspecting ? "Inspecting…" : "Inspect"}
          </Button>
          {found ? (
            <span className="text-muted-foreground text-xs">
              Found {found.skills.length} {found.skills.length === 1 ? "package" : "packages"} at{" "}
              <span className="readout">{found.revision.slice(0, 7)}</span>
            </span>
          ) : null}
        </div>
      </form>

      {error ? (
        <p role="alert" className="text-destructive text-[13px]">
          {error}
        </p>
      ) : null}

      {found ? (
        <div className="flex flex-col gap-2">
          {found.warnings.map((warning) => (
            <p key={warning} className="text-muted-foreground text-xs">
              {warning}
            </p>
          ))}
          <ul className="divide-border flex flex-col divide-y rounded-md border border-border">
            {found.skills.map((skill) => (
              <li key={skill.sourcePath} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2.5">
                <div className="flex min-w-0 flex-col">
                  <p className="text-[13px] font-medium">{skill.name}</p>
                  <p className="text-muted-foreground text-xs">{skill.description}</p>
                  <p className="text-muted-foreground readout text-xs">
                    {skill.fileCount} {skill.fileCount === 1 ? "file" : "files"}
                  </p>
                  {skill.warnings.map((warning) => (
                    <p key={warning} className="text-muted-foreground text-xs">
                      {warning}
                    </p>
                  ))}
                </div>
                {installed.has(skill.slug) ? (
                  <span role="status" className="text-muted-foreground text-xs">
                    Installed
                  </span>
                ) : (
                  <Button
                    size="sm"
                    onClick={() => install(skill)}
                    disabled={installing !== null}
                  >
                    {installing === skill.slug ? "Installing…" : "Install"}
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
