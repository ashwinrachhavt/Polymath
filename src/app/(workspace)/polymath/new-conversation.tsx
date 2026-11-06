"use client";

import { useEffect, useState } from "react";
import { ArrowUp, Puzzle, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  ComposerPlus,
  mentionAt,
  referenceLink,
  replaceMention,
  type RecordReference,
} from "@/components/chat/composer-plus";
import { startChatRun } from "@/app/(workspace)/apps/polymath/chat-actions";
import { SurfaceCardView } from "@/components/chat/surface-card";
import { fetchMentionContext } from "./mention-actions";
import { serializeChips, type ContextChip } from "@/components/chat/mention-context";
import { ContextChips } from "@/components/chat/context-chips";
import { eventFile, uploadCaptureFile } from "@/lib/capture-upload";
import { navigateInConversation } from "./navigation-actions";
import type { NavigationReply } from "@/domains/supervisor/respond";
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
export function NewConversation({
  skills = [],
  onStarted,
}: {
  skills?: PickableSkill[];
  /** The run id and the words that started it; the home swaps to the transcript. */
  onStarted: (started: { runId: string; message: string }) => void;
}) {
  const [draft, setDraft] = useState("");
  const [caret, setCaret] = useState(0);
  const [skillId, setSkillId] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attachNote, setAttachNote] = useState<string | null>(null);
  const [records, setRecords] = useState<RecordReference[] | null | undefined>(undefined);
  // Records picked as context chips — the same contract the chat composer
  // runs: fetch on pick, visible error with retry, serialize at send.
  const [chips, setChips] = useState<ContextChip[]>([]);
  // @-mention: derived from the draft and caret each render. Typing "@" starts
  // a lookup; whitespace or a deleted "@" closes it. Destructured so the
  // effect keys on the primitives — the derived object is new every render.
  const mention = mentionAt(draft, caret);
  const { open: mentionOpen, query: mentionQuery } = mention ?? { open: false, query: "" };
  // A navigation answer replaces the composer in place, exactly like a run.
  const [navigated, setNavigated] = useState<NavigationReply | null>(null);

  /*
   * Record search for the plus menu. ComposerPlus reports open state and
   * query changes; this effect debounces the fetch so a typed word does not
   * cost a request per keystroke. `records === null` means "searching";
   * closed-state `undefined` renders no result section at all.
   */
  const [plusQuery, setPlusQuery] = useState("");
  // One picker serves both gestures, as in the chat composer: menuOpen is
  // host state the plus button toggles and a typed "@" forces with the token
  // as the seed.
  const [menuOpen, setMenuOpen] = useState(false);
  const [seedQuery, setSeedQuery] = useState("");
  useEffect(() => {
    if (!mentionOpen) return;
    // Deferred a frame — synchronous setState in an effect body is what the
    // react-hooks rule bans, and a menu opening one frame late is not
    // perceptible.
    const frame = requestAnimationFrame(() => {
      setMenuOpen(true);
      setSeedQuery(mentionQuery);
    });
    return () => cancelAnimationFrame(frame);
  }, [mentionOpen, mentionQuery]);
  useEffect(() => {
    if (!menuOpen) return;
    const query = plusQuery;
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
  }, [menuOpen, plusQuery]);

  function insertReference(markdown: string) {
    setDraft((current) => (current.trim() ? `${current.trimEnd()} ${markdown} ` : `${markdown} `));
  }

  async function fetchChipContext(id: string, kind: ContextChip["entity"]["kind"]) {
    try {
      const context = await fetchMentionContext({ kind, id });
      setChips((current) =>
        current.map((chip) =>
          chip.entity.id === id
            ? context
              ? { ...chip, context, error: null }
              : { ...chip, error: "Could not load context. Retry." }
            : chip,
        ),
      );
    } catch {
      setChips((current) =>
        current.map((chip) => (chip.entity.id === id ? { ...chip, error: "Could not load context. Retry." } : chip)),
      );
    }
  }

  function pickChip(entity: ContextChip["entity"]) {
    setChips((current) => {
      if (current.some((chip) => chip.entity.id === entity.id)) return current;
      return [...current, { entity, context: null, error: null }];
    });
    void fetchChipContext(entity.id, entity.kind);
  }

  function retryChip(id: string) {
    const chip = chips.find((item) => item.entity.id === id);
    if (!chip) return;
    setChips((current) =>
      current.map((item) => (item.entity.id === id ? { ...item, context: null, error: null } : item)),
    );
    void fetchChipContext(id, chip.entity.kind);
  }

  function removeChip(id: string) {
    setChips((current) => current.filter((chip) => chip.entity.id !== id));
  }

  // One pick handler for both gestures, as in the chat composer: chip kinds
  // add a chip and leave the draft alone; reference kinds become a link,
  // replacing the live @ token when the pick came from that gesture.
  function handleRecordPick(record: RecordReference) {
    if (record.kind === "person" || record.kind === "company" || record.kind === "zettel") {
      pickChip({ id: record.id, kind: record.kind, title: record.title, href: record.href });
      return;
    }
    if (mention) {
      setDraft((current) => replaceMention(current, mention, referenceLink(record)));
      return;
    }
    insertReference(referenceLink(record));
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
    setAttachNote(`Capturing ${file.name}…`);
    void uploadCaptureFile(file).then((result) => {
      setAttachNote(result.ok ? `Captured ${file.name} to your inbox.` : result.message);
    });
  }

  // A pasted screenshot is a capture too: it uploads through the same sniffed
  // file route instead of landing in the draft as nothing.
  function pasteCapture(event: React.ClipboardEvent<HTMLTextAreaElement>) {
    const file = eventFile(event.clipboardData);
    if (!file) return;
    event.preventDefault();
    attachFile(file);
  }

  async function send() {
    const objective = draft.trim();
    if (!objective || pending) return;

    setPending(true);
    setError(null);
    try {
      /*
       * ASH-306: navigation is answered by the product, not a model run. The
       * check is deterministic and cheap (a null returns before any database
       * read); a pinned skill always takes the model path untouched.
       */
      if (!skillId) {
        const navigation = await navigateInConversation({ message: objective });
        if (navigation) {
          setNavigated(navigation);
          return;
        }
      }
      // Chips already fetched their context on pick; sending serializes
      // what is here and touches no network for it.
      const { payload } = serializeChips(chips);
      const result = await startChatRun({ objective: `${objective}${payload}`, ...(skillId ? { skillId } : {}) });
      if (!result.ok) {
        setError(result.message);
        return;
      }
      setChips([]);
      // The conversation opens in the home's started state, not on another
      // route: the runId mounts the transcript in place, and the typed message
      // crosses as the optimistic message until the stream echoes it. No
      // navigation, no reload, no lost focus.
      onStarted({ runId: result.runId, message: objective });
    } catch {
      setError("The conversation could not start. Check the connection and try again.");
    } finally {
      setPending(false);
    }
  }

  // A navigation answer is the same in-place exchange as a run: the owner's
  // message, the Supervisor's reply, and the surface card, all persisted to
  // the Supervisor thread by the action above. The thread link is a door,
  // not a requirement - the answer is already here.
  if (navigated) {
    return (
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-4">
        <div className="ml-auto max-w-[85%] rounded-lg bg-muted px-3 py-2 text-body-dense leading-6">
          {navigated.message}
        </div>
        <div className="max-w-[72ch] space-y-3">
          <p className="text-body-dense leading-6">{navigated.reply}</p>
          <SurfaceCardView card={navigated.card} />
        </div>
      </div>
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
          className="composer-input min-h-[88px] resize-none border-0 bg-transparent px-3.5 pt-3 pb-11 text-body leading-6 focus-visible:ring-0"
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
          onPaste={pasteCapture}
        />
        <div className="px-3.5 pb-10">
          <ContextChips
            chips={chips}
            onRemove={removeChip}
            onRetry={retryChip}
            truncated={serializeChips(chips).truncated}
          />
        </div>
        {/*
         * The plus sits inside the input's frame, bottom-left, like the send
         * button sits inside it bottom-right: the composer is one surface,
         * not a toolbar under a box.
         */}
        <div className="pointer-events-none absolute inset-x-0 bottom-0 flex items-center justify-between gap-2 px-2 pb-2">
          <div className="pointer-events-auto flex min-w-0 items-center gap-1">
            <ComposerPlus
              label="Add to message"
              records={records}
              open={menuOpen}
              initialQuery={seedQuery}
              onReference={handleRecordPick}
              onQueryChange={setPlusQuery}
              onOpenChange={(open) => {
                setMenuOpen(open);
                if (!open) setPlusQuery("");
              }}
              onFile={attachFile}
              items={[
                ...(skills.length > 0
                  ? [
                      {
                        label: "Pin a skill",
                        hint: "Give this conversation a procedure to follow",
                        icon: <Puzzle aria-hidden />,
                        onSelect: () => setDraft("/"),
                      },
                    ]
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
                className="bg-secondary text-secondary-foreground hover:bg-secondary/80 inline-flex h-6 items-center gap-1 rounded-md px-2 text-label outline-none"
              >
                {skills.find((skill) => skill.id === skillId)?.name ?? "Skill"}
                <X aria-hidden className="size-3.5" />
              </button>
            ) : (
              <span className="px-1 truncate text-data text-muted-foreground">{attachNote}</span>
            )}
          </div>
          <Button
            type="submit"
            size="icon"
            aria-label="Send"
            className="pointer-events-auto size-8 shrink-0 rounded-full"
            disabled={
              !draft.trim() ||
              pending ||
              // Same gate as the chat composer: a chip without fetched
              // context must not be dropped silently by a send.
              chips.some((chip) => chip.error !== null || chip.context === null)
            }
          >
            <ArrowUp aria-hidden className="size-4" />
          </Button>
        </div>
      </div>
      {error ? (
        <p role="status" className="text-destructive mt-2 text-label">
          {error}
        </p>
      ) : null}
      {pending ? (
        <p role="status" className="text-muted-foreground mt-2 text-label">
          Starting…
        </p>
      ) : null}
    </form>
  );
}
