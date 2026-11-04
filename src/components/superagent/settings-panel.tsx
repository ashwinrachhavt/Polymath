"use client";

import { useState, useTransition } from "react";
import { savePolicyAction } from "@/app/(workspace)/supervision/actions";
import { cn } from "cn";

/**
 * The Settings surface: the policy a person edits — paused, accept mode,
 * and the inferred-work rules. The server action composes the document
 * (sources ride along untouched; the version hash recomputes over the
 * whole config) so the client never round-trips a version or a source part.
 */

export type SettingsPolicy = {
  paused: boolean;
  acceptMode: "off" | "observe" | "auto";
  version: string;
  rules: { id: string; name: string; instruction: string; enabled: boolean }[];
};

const ACCEPT_MODES = [
  { mode: "off", label: "Off", hint: "Inferred candidates are not admitted." },
  { mode: "observe", label: "Observe", hint: "Inferred candidates are assessed and recorded, but not accepted." },
  { mode: "auto", label: "Auto", hint: "Inferred candidates may be accepted on matched rules." },
] as const;

type RuleDraft = { id?: string; name: string; instruction: string; enabled: boolean };

export function SettingsPanel({ policy }: { policy: SettingsPolicy }) {
  const [paused, setPaused] = useState(policy.paused);
  const [acceptMode, setAcceptMode] = useState(policy.acceptMode);
  const [rules, setRules] = useState<RuleDraft[]>(
    policy.rules.map(({ id, name, instruction, enabled }) => ({ id, name, instruction, enabled })),
  );
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const update = (index: number, patch: Partial<RuleDraft>) =>
    setRules((current) => current.map((rule, i) => (i === index ? { ...rule, ...patch } : rule)));

  const save = () =>
    start(async () => {
      const result = await savePolicyAction({
        paused,
        acceptMode,
        rules: rules.map((rule) => ({ ...rule, name: rule.name.trim(), instruction: rule.instruction.trim() })),
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setError(null);
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    });

  return (
    <div className="flex flex-col gap-6">
      <section className="panel flex flex-col gap-3 rounded-xl p-4" aria-label="Agent state">
        <label className="flex items-center gap-2 text-body-dense font-medium">
          <input type="checkbox" checked={paused} onChange={(event) => setPaused(event.target.checked)} />
          Paused
        </label>
        <p className="text-muted-foreground text-xs">
          A paused agent admits no new work. Tickets already accepted keep their mandates and may still run.
        </p>
      </section>

      <section className="panel flex flex-col gap-3 rounded-xl p-4" aria-label="Accept mode">
        <h2 className="text-body-dense font-medium">Accept mode for inferred work</h2>
        <div className="flex flex-col gap-2">
          {ACCEPT_MODES.map((option) => (
            <label key={option.mode} className="flex items-start gap-2 text-body-dense">
              <input
                type="radio"
                name="acceptMode"
                checked={acceptMode === option.mode}
                onChange={() => setAcceptMode(option.mode)}
                className="mt-1"
              />
              <span>
                <span className="font-medium">{option.label}</span>
                <span className="text-muted-foreground block text-xs">{option.hint}</span>
              </span>
            </label>
          ))}
        </div>
      </section>

      <section className="panel flex flex-col gap-3 rounded-xl p-4" aria-label="Rules">
        <div className="flex items-center justify-between">
          <h2 className="text-body-dense font-medium">Rules for inferred work</h2>
          <span className="text-muted-foreground readout text-data">Policy {policy.version.slice(0, 12)}</span>
        </div>
        {rules.length === 0 ? (
          <p className="text-muted-foreground text-xs">
            No rules yet. With accept mode off or observing, the agent assesses inferred candidates but never accepts
            them; with auto, a matched rule admits them.
          </p>
        ) : (
          <ul className="flex flex-col gap-3">
            {rules.map((rule, index) => (
              <li
                key={rule.id ?? `new-${index}`}
                className="border-border flex flex-col gap-2 border-b pb-3 last:border-0"
              >
                <div className="flex items-center gap-2">
                  <input
                    aria-label={`Rule ${index + 1} name`}
                    className="h-8 w-48 rounded-md border border-border bg-transparent px-2 text-body-dense"
                    value={rule.name}
                    placeholder="Rule name"
                    onChange={(event) => update(index, { name: event.target.value })}
                  />
                  <label className="text-muted-foreground ml-auto flex items-center gap-1.5 text-xs">
                    <input
                      type="checkbox"
                      checked={rule.enabled}
                      onChange={(event) => update(index, { enabled: event.target.checked })}
                    />
                    Enabled
                  </label>
                  <button
                    type="button"
                    onClick={() => setRules((current) => current.filter((_, i) => i !== index))}
                    className="text-muted-foreground hover:text-foreground rounded px-1.5 text-xs outline-none"
                  >
                    Remove
                  </button>
                </div>
                <textarea
                  aria-label={`Rule ${index + 1} instruction`}
                  className="min-h-16 rounded-md border border-border bg-transparent px-2 py-1.5 text-body-dense"
                  value={rule.instruction}
                  placeholder="What the agent may do when this rule matches"
                  onChange={(event) => update(index, { instruction: event.target.value })}
                />
              </li>
            ))}
          </ul>
        )}
        <button
          type="button"
          onClick={() => setRules((current) => [...current, { name: "", instruction: "", enabled: true }])}
          className="text-muted-foreground hover:bg-muted hover:text-foreground w-fit rounded px-2 py-1 text-xs outline-none"
        >
          Add rule
        </button>
      </section>

      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={save}
          disabled={pending || rules.some((rule) => rule.name.trim() === "")}
          className={cn(
            "bg-primary text-primary-foreground hover:bg-primary/90 rounded-md px-3.5 py-1.5 text-body-dense font-medium outline-none",
            "disabled:cursor-not-allowed disabled:opacity-50",
          )}
        >
          {pending ? "Saving…" : "Save policy"}
        </button>
        {error ? <span className="text-destructive text-xs">{error}</span> : null}
        {saved ? (
          <span className="text-muted-foreground text-xs">
            Saved. Running assessments discard and requeue under the new version; live mandates stay.
          </span>
        ) : null}
      </div>
      {rules.some((rule) => rule.name.trim() === "") ? (
        <p className="text-muted-foreground text-xs">Every rule needs a name before the policy can save.</p>
      ) : null}
    </div>
  );
}
