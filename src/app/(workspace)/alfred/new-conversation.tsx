"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { ArrowUp, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { startChatRun } from "@/app/(workspace)/apps/alfred/chat-actions";
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
  const router = useRouter();
  const [draft, setDraft] = useState("");
  const [skillId, setSkillId] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  async function send() {
    const objective = draft.trim();
    if (!objective || pending) return;

    /*
     * The conversation opens in place, before the run exists. Waiting for the
     * server action and then pushing a route meant a keystroke vanished behind a
     * transaction, a session create, and a full navigation — which reads as lag
     * even when every part is fast. `router.push` still runs, but only after the
     * run id is known, and the route it lands on shows this same turn.
     */
    setPending(true);
    setError(null);
    try {
      const result = await startChatRun({ objective, ...(skillId ? { skillId } : {}) });
      if (!result.ok) {
        setError(result.message);
        return;
      }
      // `replace`, not `push`: the empty home is not somewhere to go back to,
      // and the new conversation is already the thing being viewed.
      router.replace(`/alfred/${result.runId}`);
    } catch {
      setError("The conversation could not start. Check the connection and try again.");
    } finally {
      setPending(false);
    }
  }

  return (
    <form
      className="mx-auto flex w-full max-w-2xl flex-col"
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
          className="composer-input min-h-[88px] resize-none border-0 bg-transparent pr-12 text-[13px] leading-6 focus-visible:ring-0"
          placeholder={
            skillId
              ? skills.find((skill) => skill.id === skillId)?.name
                ? `Running “${skills.find((skill) => skill.id === skillId)?.name}”. Describe what to do…`
                : "Describe what to do with this skill."
              : "Ask anything or describe a task…"
          }
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              void send();
            }
          }}
        />
        <div className="flex items-center justify-between gap-2 px-2 pb-2">
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
            <span className="px-1 text-[11px] text-muted-foreground">
              Enter to send · Shift+Enter for a new line
            </span>
          )}
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
