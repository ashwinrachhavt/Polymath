"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { ChevronDown, Loader2, Pencil, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ProviderIcon } from "@/components/chat/provider-icon";
import { addMemoryAction, createAutomationAction, deleteAutomationAction, deleteMemoryAction, setProjectAccountAction, updateAutomationAction, updateProjectAction } from "./project-actions";

/*
 * The project right rail (Perplexity parity): Instructions, Sources,
 * Automations, Memory, Integrations - all live. Instructions save to the
 * project and are injected into project-scoped sessions; the connector
 * toggles scope the workspace's gateway accounts to this project.
 */

type PanelProps = { title: string; children: React.ReactNode; defaultOpen?: boolean };

function Panel({ title, children, defaultOpen = true }: PanelProps) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className="rounded-xl border border-border">
      <div className="flex items-center justify-between px-3 py-2.5">
        <button type="button" className="flex flex-1 items-center gap-1 text-left text-[13px] font-medium" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
          {title}
          <ChevronDown aria-hidden className={`size-3.5 text-muted-foreground transition-transform ${open ? "" : "-rotate-90"}`} />
        </button>
      </div>
      {open ? <div className="border-t border-border px-3 py-3">{children}</div> : null}
    </section>
  );
}

function ErrorNote({ error }: { error: string | null }) {
  if (!error) return null;
  return <p role="alert" className="mt-2 text-xs text-destructive">{error}</p>;
}

export function ProjectRightRail({
  projectId,
  instructions,
  description,
  sources,
  automations,
  memories,
  connectors,
}: {
  projectId: string;
  instructions: string | null;
  description: string | null;
  sources: Array<{ documentId: string; title: string; readiness: string }>;
  automations: Array<{ id: string; prompt: string; schedule: string; enabled: boolean }>;
  memories: Array<{ id: string; content: string }>;
  connectors: Array<{ id: string; label: string; enabled: boolean }>;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  // While an in-place conversation runs on the page, the rail folds away:
  // the transcript is the page then, and the settings return on refresh or
  // when the conversation ends. StartSession announces the same event.
  const [chatActive, setChatActive] = useState(false);

  useEffect(() => {
    function onStarted() {
      setChatActive(true);
    }
    window.addEventListener("polymath:chat-started", onStarted);
    return () => window.removeEventListener("polymath:chat-started", onStarted);
  }, []);

  if (chatActive) return null;

  function run(action: () => Promise<{ ok: boolean; error?: string }>) {
    setError(null);
    start(async () => {
      const result = await action();
      if (!result.ok) {
        setError(result.error ?? "That failed.");
        return;
      }
      router.refresh();
    });
  }

  return (
    <aside aria-label="Project controls" className="flex min-w-0 flex-col gap-3">
      {/* Instructions */}
      <Panel title="Instructions">
        <InstructionsPanel projectId={projectId} instructions={instructions} description={description} pending={pending} onSave={(patch) => run(() => updateProjectAction({ projectId, ...patch }))} />
      </Panel>

      {/* Sources */}
      <Panel title="Sources">
        {sources.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border px-3 py-6 text-center">
            <p className="text-[13px] text-muted-foreground">Add files or other resources to reference in this project.</p>
            <Button size="sm" variant="outline" className="mt-3" asChild>
              <Link href="/alfred/sources">Browse sources</Link>
            </Button>
          </div>
        ) : (
          <ul className="flex flex-col gap-2">
            {sources.map((source) => (
              <li key={source.documentId} className="text-[13px]">
                <p className="truncate">{source.title}</p>
                <p className="text-xs text-muted-foreground">{source.readiness === "ready" ? "Ready" : source.readiness}</p>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      {/* Automations */}
      <Panel title="Automations">
        <AutomationsPanel automations={automations} pending={pending} onCreate={(prompt, schedule) => run(() => createAutomationAction({ projectId, prompt, schedule }))} onToggle={(automationId, enabled) => run(() => updateAutomationAction({ projectId, automationId, enabled }))} onDelete={(automationId) => run(() => deleteAutomationAction({ projectId, automationId }))} />
      </Panel>

      {/* Memory */}
      <Panel title="Memory">
        <MemoryPanel memories={memories} pending={pending} onAdd={(content) => run(() => addMemoryAction({ projectId, content }))} onDelete={(memoryId) => run(() => deleteMemoryAction({ projectId, memoryId }))} />
      </Panel>

      {/* Integrations */}
      <Panel title="Integrations">
        {connectors.length === 0 ? (
          <p className="text-[13px] text-muted-foreground">
            Connect an account on the{" "}
            <a href="/command-center/integrations" className="underline underline-offset-2">connectors page</a> and it appears here.
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {connectors.map((connector) => (
              <ConnectorToggle key={connector.id} connector={connector} pending={pending} onSet={(gatewayAccountId, enabled) => run(() => setProjectAccountAction({ projectId, gatewayAccountId, enabled }))} />
            ))}
          </ul>
        )}
      </Panel>

      <ErrorNote error={error} />
      {pending ? <Loader2 aria-hidden className="animate-spin self-center text-muted-foreground" /> : null}
    </aside>
  );
}

function InstructionsPanel({
  projectId,
  instructions,
  description,
  pending,
  onSave,
}: {
  projectId: string;
  instructions: string | null;
  description: string | null;
  pending: boolean;
  onSave: (patch: { instructions?: string }) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(instructions ?? "");

  if (!editing) {
    return (
      <div className="flex flex-col gap-2">
        <div className="flex items-start justify-between gap-2">
          <p className="text-[13px] text-muted-foreground">{description ?? "Customize this project's responses."}</p>
          <button type="button" aria-label="Edit instructions" className="rounded p-1 hover:bg-muted" onClick={() => setEditing(true)}>
            <Pencil aria-hidden className="size-3.5" />
          </button>
        </div>
        {instructions ? <p className="whitespace-pre-wrap text-[13px]">{instructions}</p> : null}
      </div>
    );
  }
  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        onSave({ instructions: value });
        setEditing(false);
      }}
    >
      <label className="sr-only" htmlFor={`instructions-${projectId}`}>Instructions</label>
      <textarea
        id={`instructions-${projectId}`}
        value={value}
        onChange={(event) => setValue(event.target.value)}
        rows={5}
        maxLength={8000}
        placeholder="Explain what this project is for and how the assistant should work."
        className="w-full rounded-md border border-input bg-transparent px-2 py-1.5 text-[13px]"
      />
      <div className="flex justify-end gap-2">
        <Button size="sm" variant="ghost" type="button" onClick={() => { setValue(instructions ?? ""); setEditing(false); }}>
          Clear
        </Button>
        <Button size="sm" type="submit" disabled={pending}>
          Save
        </Button>
      </div>
    </form>
  );
}

function AutomationsPanel({
  automations,
  pending,
  onCreate,
  onToggle,
  onDelete,
}: {
  automations: Array<{ id: string; prompt: string; schedule: string; enabled: boolean }>;
  pending: boolean;
  onCreate: (prompt: string, schedule: string) => void;
  onToggle: (automationId: string, enabled: boolean) => void;
  onDelete: (automationId: string) => void;
}) {
  const [adding, setAdding] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [schedule, setSchedule] = useState("0 8 * * *");

  return (
    <div className="flex flex-col gap-2">
      <p className="text-xs text-muted-foreground">Run tasks on a schedule in this project.</p>
      {automations.map((automation) => (
        <div key={automation.id} className="flex items-start justify-between gap-2 rounded-md border border-border px-2 py-2">
          <div className="min-w-0">
            <p className="truncate text-[13px]">{automation.prompt}</p>
            <p className="font-mono text-xs text-muted-foreground">{automation.schedule}</p>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <label className="flex cursor-pointer items-center gap-1 text-xs">
              <input type="checkbox" checked={automation.enabled} disabled={pending} onChange={(event) => onToggle(automation.id, event.target.checked)} />
              on
            </label>
            <button type="button" aria-label="Delete automation" className="rounded p-1 hover:bg-muted" disabled={pending} onClick={() => onDelete(automation.id)}>
              <Trash2 aria-hidden className="size-3.5" />
            </button>
          </div>
        </div>
      ))}
      {adding ? (
        <form
          className="flex flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            onCreate(prompt, schedule);
            setPrompt("");
            setAdding(false);
          }}
        >
          <textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} rows={3} required maxLength={4000} placeholder="What should it do?" className="w-full rounded-md border border-input bg-transparent px-2 py-1.5 text-[13px]" />
          <input value={schedule} onChange={(event) => setSchedule(event.target.value)} className="rounded-md border border-input bg-transparent px-2 py-1.5 font-mono text-[13px]" aria-label="Cron schedule" />
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" type="button" onClick={() => setAdding(false)}>Cancel</Button>
            <Button size="sm" type="submit" disabled={pending || !prompt.trim()}>Add</Button>
          </div>
        </form>
      ) : (
        <Button size="sm" variant="outline" className="w-fit" onClick={() => setAdding(true)}>
          <Plus aria-hidden /> New automation
        </Button>
      )}
    </div>
  );
}

function MemoryPanel({
  memories,
  pending,
  onAdd,
  onDelete,
}: {
  memories: Array<{ id: string; content: string }>;
  pending: boolean;
  onAdd: (content: string) => void;
  onDelete: (memoryId: string) => void;
}) {
  const [value, setValue] = useState("");
  return (
    <div className="flex flex-col gap-2">
      <p className="text-xs text-muted-foreground">Context that this project remembers.</p>
      {memories.map((memory) => (
        <div key={memory.id} className="group flex items-start justify-between gap-2 text-[13px]">
          <p className="min-w-0 flex-1">{memory.content}</p>
          <button type="button" aria-label="Delete memory" className="rounded p-1 opacity-0 group-hover:opacity-100 hover:bg-muted" disabled={pending} onClick={() => onDelete(memory.id)}>
            <Trash2 aria-hidden className="size-3.5" />
          </button>
        </div>
      ))}
      <form
        className="flex items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          onAdd(value);
          setValue("");
        }}
      >
        <div className="min-w-0 flex-1">
          <label className="sr-only" htmlFor="project-memory-input">Add memory</label>
          <input id="project-memory-input" value={value} onChange={(event) => setValue(event.target.value)} maxLength={2000} placeholder="Add a memory" className="w-full rounded-md border border-input bg-transparent px-2 py-1.5 text-[13px]" />
        </div>
        <Button size="sm" variant="outline" type="submit" disabled={pending || !value.trim()}>Add</Button>
      </form>
    </div>
  );
}

function ConnectorToggle({
  connector,
  pending,
  onSet,
}: {
  connector: { id: string; label: string; enabled: boolean };
  pending: boolean;
  onSet: (gatewayAccountId: string, enabled: boolean) => void;
}) {
  // "Label — alias" splits at the em-dash-free separator the caller builds;
  // the alias is the account's own name and belongs on the second line.
  const [name, alias] = connector.label.split(" — ");
  return (
    <li className="flex items-center gap-2.5 py-0.5">
      <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-muted">
        <ProviderIcon provider={alias ?? name} displayName={name} />
      </span>
      <span className="min-w-0 flex-1 leading-tight">
        <span className="block truncate text-[13px]">{name}</span>
        {alias && alias !== name ? (
          <span className="block truncate text-[11px] text-muted-foreground">{alias}</span>
        ) : null}
      </span>
      <button
        type="button"
        role="switch"
        aria-checked={connector.enabled}
        aria-label={`${connector.enabled ? "Disconnect" : "Connect"} ${name}`}
        disabled={pending}
        onClick={() => onSet(connector.id, !connector.enabled)}
        className={`relative h-5 w-9 shrink-0 rounded-full transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 ${
          connector.enabled ? "bg-primary" : "bg-input"
        }`}
      >
        <span
          aria-hidden
          className={`absolute top-0.5 size-4 rounded-full bg-background shadow-sm transition-transform ${
            connector.enabled ? "translate-x-4.5 left-0.5" : "left-0.5"
          }`}
        />
      </button>
    </li>
  );
}
