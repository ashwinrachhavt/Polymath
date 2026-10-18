"use client";

import { useWorkspace } from "@/components/workspace/workspace-provider";
import { compareTasks, openStatuses, statusLabels } from "@/components/workspace/tasks";
import { EmptyState } from "@/components/empty-state";
import { Readout } from "@/components/readout";
import { Section } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Check } from "lucide-react";

/*
 * Today, read from the workspace rather than asserted. The server page renders
 * the header and this client island below it, because the tasks live in a
 * store that only exists in the browser — a server component cannot see them,
 * and hardcoding "0 open" while the store held real rows was a lie the screen
 * told on every load.
 */
export function WorkToday() {
  const { state, completeTask, notify } = useWorkspace();
  const open = state.tasks.filter((task) => openStatuses.includes(task.status)).sort(compareTasks);
  const doneToday = state.tasks.filter((task) => task.status === "DONE" && task.completedAt?.slice(0, 10) === new Date().toISOString().slice(0, 10));

  return (
    <Section
      title="Today"
      description="Accepted outcomes first, then ready work, then what is waiting."
    >
      {open.length === 0 ? (
        <EmptyState
          title="No open tasks"
          description="Tasks arrive from capture, from Alfred, or from the Inbox and Briefing screens."
          action={<Button variant="outline" onClick={() => notify("Capturing from Work arrives with the capture command.")}>Capture a task</Button>}
        />
      ) : (
        <ul className="flex flex-col">
          {open.map((task) => (
            <li key={task.id} className="border-border flex items-center gap-3 border-b py-2 last:border-b-0">
              <Button
                variant="ghost"
                size="sm"
                aria-label={`Complete ${task.title}`}
                onClick={() => completeTask(task.id)}
                className="text-muted-foreground hover:text-foreground -ml-2 shrink-0 px-2"
              >
                <Check aria-hidden />
              </Button>
              <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{task.title}</span>
              {task.dueDate ? <span className="text-muted-foreground shrink-0 text-[13px]">{task.dueDate}</span> : null}
              {/* Word, not hue alone: the status is readable without colour. */}
              <Badge variant="outline" className="shrink-0">{statusLabels[task.status]}</Badge>
            </li>
          ))}
        </ul>
      )}
      <p className="text-muted-foreground mt-3 flex items-center gap-2 text-[13px]">
        <Readout>{open.length}</Readout> open
        {doneToday.length ? <><span aria-hidden>·</span><Readout>{doneToday.length}</Readout> done today</> : null}
      </p>
    </Section>
  );
}

/*
 * Spaces are a Command Center grouping; projects carry an outcome. Neither has
 * rows in the workspace store yet, so this states the distinction rather than
 * drawing three identical empty boxes that say nothing about what they hold.
 */
export function WorkContainers() {
  const { state } = useWorkspace();
  return (
    <Section title="Spaces and projects" description="Spaces group; projects carry an outcome.">
      {state.projects.length === 0 ? (
        <p className="text-muted-foreground text-[13px]">
          No projects yet. A project carries one outcome to done; spaces group related work across projects.
        </p>
      ) : (
        <ul className="flex flex-col">
          {state.projects.map((project) => (
            <li key={project.id} className="border-border flex items-center gap-3 border-b py-2 last:border-b-0">
              <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{project.title}</span>
              <Badge variant="outline">{project.status}</Badge>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}
