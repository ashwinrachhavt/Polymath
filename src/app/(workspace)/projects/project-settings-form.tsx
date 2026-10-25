"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Loader2, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  addMemoryAction,
  createAutomationAction,
  deleteAutomationAction,
  deleteMemoryAction,
  setProjectAccountAction,
  updateAutomationAction,
  updateProjectAction,
} from "./project-actions";

/*
 * The settings body under /projects/[id]/settings. Same operations as the
 * right rail, laid out as one scrolling form with section navigation.
 */

type Section = "general" | "sources" | "automations" | "memory" | "integrations";

const SECTIONS: Array<{ key: Section; label: string }> = [
  { key: "general", label: "General" },
  { key: "sources", label: "Sources" },
  { key: "automations", label: "Automations" },
  { key: "memory", label: "Memory" },
  { key: "integrations", label: "Integrations" },
];

export function ProjectSettingsForm({
  projectId,
  project,
  sources,
  automations,
  memories,
  connectors,
}: {
  projectId: string;
  project: { title: string; description: string | null; instructions: string | null; emoji: string | null };
  sources: Array<{ documentId: string; title: string; readiness: string }>;
  automations: Array<{ id: string; prompt: string; schedule: string; enabled: boolean }>;
  memories: Array<{ id: string; content: string }>;
  connectors: Array<{ id: string; label: string; enabled: boolean }>;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [title, setTitle] = useState(project.title);
  const [description, setDescription] = useState(project.description ?? "");
  const [instructions, setInstructions] = useState(project.instructions ?? "");
  const [emoji, setEmoji] = useState(project.emoji ?? "");

  function run(action: () => Promise<{ ok: boolean; error?: string }>, done?: () => void) {
    setError(null);
    setNotice(null);
    start(async () => {
      const result = await action();
      if (!result.ok) {
        setError(result.error ?? "That failed.");
        return;
      }
      done?.();
      setNotice("Saved.");
      router.refresh();
    });
  }

  return (
    <div className="grid gap-8 md:grid-cols-[180px_minmax(0,1fr)]">
      <nav aria-label="Settings sections" className="flex flex-col gap-1">
        {SECTIONS.map((section) => (
          <a key={section.key} href={`#${section.key}`} className="rounded-md px-3 py-1.5 text-[13px] text-muted-foreground hover:bg-muted hover:text-foreground">
            {section.label}
          </a>
        ))}
        <span aria-disabled className="rounded-md px-3 py-1.5 text-[13px] text-muted-foreground/50">Members</span>
        <span aria-disabled className="rounded-md px-3 py-1.5 text-[13px] text-muted-foreground/50">Skills</span>
      </nav>

      <div className="flex min-w-0 flex-col gap-10">
        <section id="general" aria-label="General" className="flex flex-col gap-4">
          <h2 className="text-lg font-medium">General</h2>
          <div className="flex flex-col gap-1.5">
            <label htmlFor="project-name" className="text-[13px]">Name</label>
            <input id="project-name" value={title} onChange={(event) => setTitle(event.target.value)} maxLength={200} className="h-9 rounded-md border border-input bg-transparent px-3 text-sm" />
          </div>
          <div className="flex flex-col gap-1.5">
            <label htmlFor="project-emoji" className="text-[13px]">Emoji</label>
            <input id="project-emoji" value={emoji} onChange={(event) => setEmoji(event.target.value)} maxLength={8} className="h-9 w-20 rounded-md border border-input bg-transparent px-3 text-sm" />
          </div>
          <div className="flex flex-col gap-1.5">
            <label htmlFor="project-description" className="text-[13px]">Description</label>
            <textarea id="project-description" value={description} onChange={(event) => setDescription(event.target.value)} rows={3} maxLength={2000} className="rounded-md border border-input bg-transparent px-3 py-2 text-sm" />
          </div>
          <div className="flex flex-col gap-1.5">
            <label htmlFor="project-instructions" className="text-[13px]">Instructions</label>
            <p className="text-xs text-muted-foreground">Explain what this project is for and how the assistant should work.</p>
            <textarea id="project-instructions" value={instructions} onChange={(event) => setInstructions(event.target.value)} rows={6} maxLength={8000} className="rounded-md border border-input bg-transparent px-3 py-2 text-sm" />
          </div>
          <div className="flex items-center justify-end gap-3">
            {error ? <p role="alert" className="text-xs text-destructive">{error}</p> : null}
            {notice ? <p role="status" className="text-xs text-muted-foreground">{notice}</p> : null}
            <Button
              size="sm"
              disabled={pending}
              onClick={() => run(() => updateProjectAction({ projectId, title, description, instructions, emoji: emoji || undefined }))}
            >
              {pending ? <Loader2 aria-hidden className="animate-spin" /> : "Save"}
            </Button>
          </div>
        </section>

        <section id="sources" aria-label="Sources" className="flex flex-col gap-3">
          <h2 className="text-lg font-medium">Sources</h2>
          {sources.length === 0 ? (
            <p className="text-[13px] text-muted-foreground">
              No sources yet. Add them from <Link href="/alfred/sources" className="underline">Sources</Link> and attach them to this project.
            </p>
          ) : (
            <ul className="flex flex-col gap-1">
              {sources.map((source) => (
                <li key={source.documentId} className="flex items-baseline justify-between gap-2 border-b border-border py-2 text-[13px] last:border-0">
                  <span className="truncate">{source.title}</span>
                  <span className="text-xs text-muted-foreground">{source.readiness === "ready" ? "Ready" : source.readiness}</span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section id="automations" aria-label="Automations" className="flex flex-col gap-3">
          <h2 className="text-lg font-medium">Automations</h2>
          {automations.map((automation) => (
            <div key={automation.id} className="flex items-start justify-between gap-3 rounded-md border border-border px-3 py-2.5">
              <div className="min-w-0">
                <p className="text-[13px]">{automation.prompt}</p>
                <p className="font-mono text-xs text-muted-foreground">{automation.schedule}</p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <label className="flex cursor-pointer items-center gap-1 text-xs">
                  <input
                    type="checkbox"
                    checked={automation.enabled}
                    disabled={pending}
                    onChange={(event) => run(() => updateAutomationAction({ projectId, automationId: automation.id, enabled: event.target.checked }))}
                  />
                  {automation.enabled ? "On" : "Off"}
                </label>
                <button
                  type="button"
                  aria-label="Delete automation"
                  className="rounded p-1 hover:bg-muted"
                  disabled={pending}
                  onClick={() => run(() => deleteAutomationAction({ projectId, automationId: automation.id }))}
                >
                  <Trash2 aria-hidden className="size-4" />
                </button>
              </div>
            </div>
          ))}
          <NewAutomation pending={pending} onCreate={(prompt, schedule) => run(() => createAutomationAction({ projectId, prompt, schedule }))} />
        </section>

        <section id="memory" aria-label="Memory" className="flex flex-col gap-3">
          <h2 className="text-lg font-medium">Memory</h2>
          <p className="text-[13px] text-muted-foreground">Context that this project remembers.</p>
          {memories.map((memory) => (
            <div key={memory.id} className="group flex items-start justify-between gap-3 border-b border-border py-2 text-[13px] last:border-0">
              <p className="min-w-0 flex-1">{memory.content}</p>
              <button
                type="button"
                aria-label="Delete memory"
                className="rounded p-1 opacity-0 group-hover:opacity-100 hover:bg-muted"
                disabled={pending}
                onClick={() => run(() => deleteMemoryAction({ projectId, memoryId: memory.id }))}
              >
                <Trash2 aria-hidden className="size-3.5" />
              </button>
            </div>
          ))}
          <NewMemory pending={pending} onAdd={(content) => run(() => addMemoryAction({ projectId, content }))} />
        </section>

        <section id="integrations" aria-label="Integrations" className="flex flex-col gap-3">
          <h2 className="text-lg font-medium">Integrations</h2>
          {connectors.length === 0 ? (
            <p className="text-[13px] text-muted-foreground">
              Connect accounts on the <Link href="/command-center/integrations" className="underline">connectors page</Link>.
            </p>
          ) : (
            <ul className="flex flex-col gap-2">
              {connectors.map((connector) => (
                <li key={connector.id} className="flex items-center justify-between gap-3 border-b border-border py-2 text-[13px] last:border-0">
                  <span className="truncate">{connector.label}</span>
                  <label className="flex shrink-0 cursor-pointer items-center gap-1.5 text-xs text-muted-foreground">
                    <input
                      type="checkbox"
                      checked={connector.enabled}
                      disabled={pending}
                      onChange={(event) => run(() => setProjectAccountAction({ projectId, gatewayAccountId: connector.id, enabled: event.target.checked }))}
                    />
                    {connector.enabled ? "Connected" : "Connect"}
                  </label>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}

function NewAutomation({ pending, onCreate }: { pending: boolean; onCreate: (prompt: string, schedule: string) => void }) {
  const [adding, setAdding] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [schedule, setSchedule] = useState("0 8 * * *");
  if (!adding) {
    return (
      <Button size="sm" variant="outline" className="w-fit" onClick={() => setAdding(true)}>
        <Plus aria-hidden /> New automation
      </Button>
    );
  }
  return (
    <form
      className="flex flex-col gap-2 rounded-md border border-border px-3 py-3"
      onSubmit={(event) => {
        event.preventDefault();
        onCreate(prompt, schedule);
        setPrompt("");
        setAdding(false);
      }}
    >
      <textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} rows={3} required maxLength={4000} placeholder="What should it do?" className="w-full rounded-md border border-input bg-transparent px-2 py-1.5 text-[13px]" />
      <input value={schedule} onChange={(event) => setSchedule(event.target.value)} aria-label="Cron schedule" className="w-40 rounded-md border border-input bg-transparent px-2 py-1.5 font-mono text-[13px]" />
      <div className="flex justify-end gap-2">
        <Button size="sm" variant="ghost" type="button" onClick={() => setAdding(false)}>Cancel</Button>
        <Button size="sm" type="submit" disabled={pending || !prompt.trim()}>Add</Button>
      </div>
    </form>
  );
}

function NewMemory({ pending, onAdd }: { pending: boolean; onAdd: (content: string) => void }) {
  const [value, setValue] = useState("");
  return (
    <form
      className="flex items-end gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        onAdd(value);
        setValue("");
      }}
    >
      <div className="min-w-0 flex-1">
        <label className="sr-only" htmlFor="settings-memory-input">Add memory</label>
        <input id="settings-memory-input" value={value} onChange={(event) => setValue(event.target.value)} maxLength={2000} placeholder="Add a memory" className="w-full rounded-md border border-input bg-transparent px-3 py-2 text-[13px]" />
      </div>
      <Button size="sm" variant="outline" type="submit" disabled={pending || !value.trim()}>Add</Button>
    </form>
  );
}
