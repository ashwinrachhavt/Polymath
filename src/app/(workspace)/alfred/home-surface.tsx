"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Plus } from "lucide-react";
import { InPlaceChat } from "@/components/chat/in-place-chat";
import type { ModelOption } from "@/domains/agents/models";
import { HistoryMenu } from "./history-menu";
import type { HistoryGroup } from "./history";
import { ModelPicker } from "./model-picker";
import { NewConversation } from "./new-conversation";
import { continueConversation } from "./continue-actions";
import type { PickableSkill } from "./skills/slash-skill-menu";

/*
 * The Assistant home in two states, and only ever one of them.
 *
 * Idle: the greeting, the composer, and every conversation the person already
 * has, grouped by day. Nothing else — no chrome for a conversation that does
 * not exist yet.
 *
 * Started: the conversation takes the whole canvas. The home's greeting,
 * composer and list are gone rather than stacked under a transcript, and the
 * history folds into one chip at the top-left, which is the only thing the
 * person needs from the idle screen once they are mid-thought.
 *
 * The switch is local state rather than a route: the run starts in place, so
 * navigating would drop the stream and re-mount the transcript.
 */
export function HomeSurface({
  history,
  skills,
  models,
  currentModel,
  notice,
  activeRunId,
}: {
  history: HistoryGroup[];
  skills: PickableSkill[];
  models: ModelOption[];
  currentModel: string;
  /** A bridge problem, stated once under the composer. */
  notice: string | null;
  /** The run still in progress, when there is one: the home reopens it. */
  activeRunId: string | null;
}) {
  const [started, setStarted] = useState<{ runId: string; message?: string } | null>(
    activeRunId ? { runId: activeRunId } : null,
  );
  const router = useRouter();
  const [, startTransition] = useTransition();

  if (started) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        {/*
         * A borderless row, not a top bar: on this screen the chip is the only
         * chrome, and a rule above the transcript would claim a section the
         * conversation has already filled.
         */}
        <div className="flex h-12 shrink-0 items-center gap-1 px-4 md:px-6">
          <HistoryMenu groups={history} label="Chats" />
          <button
            type="button"
            onClick={() => {
              setStarted(null);
              // The conversation just held here is now history: reload the
              // groups so it appears without a manual refresh.
              startTransition(() => router.refresh());
            }}
            className="text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-ring inline-flex h-7 shrink-0 items-center gap-1 rounded-md px-2 text-[12px] whitespace-nowrap outline-none transition-colors focus-visible:ring-2"
          >
            <Plus aria-hidden className="size-3.5 shrink-0" />
            <span>New chat</span>
          </button>
          {/* The model is frozen per run; it stays reachable, off the reading column. */}
          <div className="ml-auto min-w-0">
            <ModelPicker models={models} current={currentModel} />
          </div>
        </div>

        <div className="mx-auto flex w-full min-h-0 max-w-3xl flex-1 flex-col px-4 md:px-6">
          <InPlaceChat
            runId={started.runId}
            subject={{ type: "project", id: "" }}
            {...(started.message ? { optimisticMessage: started.message } : {})}
            onContinue={(runId, text) => continueConversation({ runId, text })}
            className="flex min-h-0 flex-1 flex-col"
          />
        </div>
      </div>
    );
  }

  return (
    <div className="page-content flex flex-1 flex-col gap-12 pt-[12vh] pb-16">
      <h1 className="screen-title text-center">What would you like to work on?</h1>

      <div className="mx-auto flex w-full max-w-3xl flex-col gap-2">
        <NewConversation skills={skills} onStarted={setStarted} />
        <div className="flex items-center justify-between gap-2">
          <ModelPicker models={models} current={currentModel} />
          {notice ? (
            <p role="status" className="text-muted-foreground min-w-0 truncate text-[11px]">
              {notice}
            </p>
          ) : null}
        </div>
      </div>

      {history.length > 0 ? (
        <section aria-label="Your conversations" className="mx-auto flex w-full max-w-3xl flex-col gap-6">
          {history.map((group) => (
            <section key={group.key} aria-label={group.label}>
              <p className="text-muted-foreground px-2 pb-1 text-[11px] font-medium">{group.label}</p>
              <ul>
                {group.rows.map((row) => (
                  <li key={row.id}>
                    <Link
                      href={row.href}
                      className="hover:bg-muted/70 focus-visible:ring-ring -mx-2 flex h-9 items-center gap-3 rounded-md px-2 text-[13px] transition-colors outline-none focus-visible:ring-2"
                    >
                      <span className="min-w-0 flex-1 truncate">{row.title}</span>
                      <span className="text-muted-foreground shrink-0 text-[11px] tabular-nums">
                        {row.time}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </section>
      ) : null}
    </div>
  );
}
