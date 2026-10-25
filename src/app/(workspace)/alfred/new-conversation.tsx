"use client";

import { useEffect, useState } from "react";
import { ArrowUp, Puzzle, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  ComposerPlus,
  mentionAt,
  replaceMention,
  type RecordReference,
} from "@/components/chat/composer-plus";
import { startChatRun } from "@/app/(workspace)/apps/alfred/chat-actions";
import { announceChatStarted } from "@/components/chat/chat-events";
import { InPlaceChat } from "@/components/chat/in-place-chat";
import { SlashSkillMenu, type PickableSkill } from "./skills/slash-skill-menu";

/*
 * The one mutation on the home screen: a sentence becomes a run.
 *
 * The page has no record in hand, so the run carries no subject. `engine.start`
 * stores `subjects` verbatim and the column defaults to `[]`, which is the
 * honest value for a conversation that is not about a specific artifact.
 *
 * Idempotency is the island's, not the action's: `startChatRun` claims no
 * receipt (see its own comment), so the only available guard is one in-flight
 * submit at a time. A key generated here would be dropped on the floor by the
 * server, so none is generated; the pending flag is the whole guard, and it is
 * cleared in `finally` so a failed start cannot leave the composer stuck.
 *
 * A failed start keeps the draft. Losing typed text on a send that did not
 * happen is the worst failure this screen can produce.
 */
export function NewConversation({ skills = [] }: { skills?: PickableSkill[] }) {
  const [draft, setDraft] = useState("");
  const [caret, setCaret] = useState(0);
  const [skillId, setSkillId] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attachNote, setAttachNote] = useState<string | null>(null);
  const [records, setRecords] = useState<RecordReference[] | null | undefined>(undefined);
  // Set on send: the conversation then renders in place, replacing the composer.
  const [started, setStarted] = useState<{ runId: string; message: string } | null>(null);

  /*
   * Record search for the plus menu. ComposerPlus reports open state and
   * query changes; this effect debounces the fetch so a typed word does not
   * cost a request per keystroke. `records === null` means "searching";
   * closed-state `undefined` renders no result section at all.
   */
  const [plusOpen, setPlusOpen] = useState(false);
  const [plusQuery, setPlusQuery] = useState("");
  // @-mention: derived from the draft and caret each render. Typing "@" starts
  // a lookup; whitespace or a deleted "@" closes it. The effect below keys on
  // the primitives, not the object, so a caret move that keeps the token does
  // not re-fetch.
  const mention = mentionAt(draft, caret);
  const mentionOpen = mention?.open ?? false;
  const mentionQuery = mention?.query ?? "";
  useEffect(() => {
    if (!plusOpen && !mentionOpen) return;
    const query = mentionOpen ? mentionQuery : plusQuery;
    const controller = new AbortController();
    // Fetching lands in the timeout, so every setRecords call is async from
    // React's view — no synchronous setState inside the effect body.
    const timer = setTimeout(() => {
      void fetch(`/api/v1/records/search?q=${encodeURIComponent(query)}`, { signal: controller.signal })
        .then((res) => (res.ok ? res.json() : { records: [] }))
        .then((body: { records?: RecordReference[] }) => setRecords(body.records ?? []))
        .catch(() => setRecords([]));
    }, 150);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [plusOpen, plusQuery, mentionOpen, mentionQuery]);

  function insertReference(markdown: string) {
    setDraft((current) => (current.trim() ? `${current.trimEnd()} ${markdown} ` : `${markdown} `));
  }

  /*
   * "/" as the first character opens the skill menu; the rest of the draft
   * filters it. Picking a skill pins it and clears the draft, so the slash
   * token never reaches the run as part of the objective.
   */
  const slashOpen = draft.startsWith("/");
  const slashQuery = draft.slice(1);

  function pickSkill(skill: PickableSkill) {
    setSkillId(skill.id);
    setDraft("");
  }

  /*
   * Attach captures the file into the inbox through the same multipart route
   * the command layer uses (server actions cap below the upload ceiling); the
   * conversation itself stays text-only. The note names what happened so the
   * file landing in the inbox never reads as it joining this run.
   */
  function attachFile(file: File) {
    if (file.size > 4 * 1024 * 1024) {
      setAttachNote("Captures are limited to 4 MB - the file was not attached.");
      return;
    }
    setAttachNote(`Capturing ${file.name}…`);
    const form = new FormData();
    form.set("file", file);
    void fetch("/api/v1/captures/file", { method: "POST", headers: { "idempotency-key": crypto.randomUUID() }, body: form })
      .then(async (res) => {
        if (!res.ok) {
          if (res.status === 413) { setAttachNote("That file is over the 4 MB limit."); return; }
          const problem = (await res.json().catch(() => null)) as { title?: string } | null;
          setAttachNote(problem?.title ?? "Could not capture the file. Try again.");
          return;
        }
        setAttachNote(`Captured ${file.name} to your inbox.`);
      })
      .catch(() => setAttachNote("Could not capture the file. Try again."));
  }

  async function send() {
    const objective = draft.trim();
    if (!objective || pending) return;

    setPending(true);
    setError(null);
    try {
      const result = await startChatRun({ objective, ...(skillId ? { skillId } : {}) });
      if (!result.ok) {
        setError(result.message);
        return;
      }
      // The conversation opens here, not on another route: the runId mounts
      // ChatSurface in place below, and the typed message crosses as the
      // optimistic message until the stream echoes it. No navigation, no
      // reload, no lost focus.
      setStarted({ runId: result.runId, message: objective });
      announceChatStarted();
    } catch {
      setError("The conversation could not start. Check the connection and try again.");
    } finally {
      setPending(false);
    }
  }

  // A started conversation replaces the composer in place: the run streams
  // here, on the home, with no navigation. The URL follows once the person
  // wants to share or reload; the conversation itself never moved.
  if (started) {
    return (
      <InPlaceChat
        runId={started.runId}
        subject={{ type: "project", id: "" }}
        optimisticMessage={started.message}
        className="mx-auto flex h-[min(72dvh,720px)] w-full max-w-3xl flex-col"
      />
    );
  }

  return (
    <form
      className="mx-auto flex w-full max-w-3xl flex-col"
      onSubmit={(event) => {
        event.preventDefault();
        void send();
      }}
    >
      <div className="panel relative rounded-xl has-[:focus-visible]:ring-3 has-[:focus-visible]:ring-ring/50">
        <SlashSkillMenu
          skills={skills}
          open={slashOpen}
          query={slashQuery}
          onPick={pickSkill}
          onClose={() => setDraft((current) => ` ${current}`)}
        />
        <Textarea
          autoFocus
          aria-label="Start a conversation"
          className="composer-input min-h-[88px] resize-none border-0 bg-transparent px-3.5 pt-3 pb-11 text-[13px] leading-6 focus-visible:ring-0"
          placeholder={
            skillId
              ? skills.find((skill) => skill.id === skillId)?.name
                ? `Running “${skills.find((skill) => skill.id === skillId)?.name}”. Describe what to do…`
                : "Describe what to do with this skill."
              : "Ask anything or describe a task…"
          }
          value={draft}
          onChange={(event) => {
            setDraft(event.target.value);
            setCaret(event.target.selectionStart ?? event.target.value.length);
          }}
          onSelect={(event) => {
            const target = event.currentTarget;
            setCaret(target.selectionStart ?? target.value.length);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              void send();
            }
          }}
        />
        {/*
         * The plus sits inside the input's frame, bottom-left, like the send
         * button sits inside it bottom-right: the composer is one surface,
         * not a toolbar under a box.
         */}
        <div className="absolute inset-x-0 bottom-0 flex items-center justify-between gap-2 px-2 pb-2">
          <div className="flex min-w-0 items-center gap-1">
            <ComposerPlus
              label="Add to message"
              records={records}
              onReference={insertReference}
              onQueryChange={setPlusQuery}
              onFile={attachFile}
              mention={mention}
              onMentionPick={(record) => {
                if (!mention) return;
                setDraft((current) => replaceMention(current, mention, `[${record.title}](${record.href})`));
              }}
              onOpenChange={(open) => {
                setPlusOpen(open);
                if (!open) setPlusQuery("");
              }}
              items={[
                ...(skills.length > 0
                  ? [{
                      label: "Pin a skill",
                      hint: "Give this conversation a procedure to follow",
                      icon: <Puzzle aria-hidden />,
                      onSelect: () => setDraft("/"),
                    }]
                  : []),
              ]}
            />
            {/*
             * The slash menu is the only way to pin a skill; the picker dropdown
             * is gone. When one is pinned, a chip names it and offers the
             * unpin, so the state stays visible without a control that fronts
             * every conversation.
             */}
            {skillId ? (
              <button
                type="button"
                onClick={() => setSkillId("")}
                aria-label={`Unpin skill ${skills.find((skill) => skill.id === skillId)?.name ?? skillId}`}
                className="bg-secondary text-secondary-foreground hover:bg-secondary/80 inline-flex h-6 items-center gap-1 rounded-md px-2 text-[12px] outline-none"
              >
                {skills.find((skill) => skill.id === skillId)?.name ?? "Skill"}
                <X aria-hidden className="size-3" />
              </button>
            ) : (
              <span className="px-1 truncate text-[11px] text-muted-foreground">
                {attachNote ?? "Enter to send · Shift+Enter for a new line"}
              </span>
            )}
          </div>
          <Button
            type="submit"
            size="icon"
            aria-label="Send"
            className="size-8 shrink-0 rounded-full"
            disabled={!draft.trim() || pending}
          >
            <ArrowUp aria-hidden className="size-4" />
          </Button>
        </div>
      </div>
      {error ? (
        <p role="status" className="text-destructive mt-2 text-[12px]">
          {error}
        </p>
      ) : null}
      {pending ? (
        <p role="status" className="text-muted-foreground mt-2 text-[12px]">
          Starting…
        </p>
      ) : null}
    </form>
  );
}
