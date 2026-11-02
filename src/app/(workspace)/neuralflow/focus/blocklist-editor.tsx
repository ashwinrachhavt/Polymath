"use client";

import { useState, useTransition } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { createBlocklistEntryAction, archiveBlocklistEntryAction } from "../work/actions";

/**
 * The setup screen's blocklist editor (spec §1): the entries the extension
 * reads when a Deep session is live. Patterns canonicalize server-side; the
 * unique-key race surfaces here as the conflict message, not a crash.
 */
export function BlocklistEditor({ entries }: { entries: { id: string; pattern: string; kind: "block" | "allow" }[] }) {
  const [pattern, setPattern] = useState("");
  const [kind, setKind] = useState<"block" | "allow">("block");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const add = () => {
    const trimmed = pattern.trim();
    if (!trimmed) return;
    startTransition(async () => {
      const result = await createBlocklistEntryAction({ pattern: trimmed, kind });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setError(null);
      setPattern("");
    });
  };

  const archive = (blockId: string) => {
    startTransition(async () => {
      const result = await archiveBlocklistEntryAction({ blockId });
      if (!result.ok) setError(result.error);
    });
  };

  return (
    <section className="panel min-w-0 rounded-xl p-4" aria-label="Blocklist">
      <div className="mb-4">
        <h2 className="text-[13px] font-medium">Blocklist</h2>
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
          During a Deep session the extension blocks these sites. An allow entry is exempt - use it for the one
          dashboard Deep work actually needs.
        </p>
      </div>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Input
          aria-label="Site or pattern"
          placeholder="e.g. youtube.com"
          value={pattern}
          onChange={(event) => setPattern(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              add();
            }
          }}
          className="max-w-64"
        />
        <Select
          value={kind}
          onChange={(event) => setKind(event.target.value as "block" | "allow")}
          aria-label="Entry kind"
          className="max-w-32"
        >
          <option value="block">Block</option>
          <option value="allow">Allow</option>
        </Select>
        <Button disabled={pending || !pattern.trim()} onClick={add}>
          Add entry
        </Button>
      </div>
      {error ? (
        <p role="alert" className="mb-3 text-xs text-destructive">
          {error}
        </p>
      ) : null}
      {entries.length === 0 ? (
        <p className="text-xs leading-relaxed text-muted-foreground">
          Nothing blocked yet. Add the sites that pull you away.
        </p>
      ) : (
        <ul className="grid gap-1.5">
          {entries.map((entry) => (
            <li
              key={entry.id}
              className="flex items-center justify-between gap-3 rounded-lg border border-border px-3 py-2"
            >
              <span className="flex min-w-0 items-center gap-2">
                <Badge variant={entry.kind === "allow" ? "secondary" : "default"}>{entry.kind}</Badge>
                <span className="truncate text-[13px]">{entry.pattern}</span>
              </span>
              <Button variant="ghost" disabled={pending} onClick={() => archive(entry.id)}>
                Archive
              </Button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
