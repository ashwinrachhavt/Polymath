"use client";

import { useEffect, useMemo, useRef, useState, useOptimistic, useTransition } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Bell } from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { NotificationCard } from "@/components/shell/notifications/NotificationCard";
import { useWorkspace } from "@/components/workspace/workspace-provider";
import { decideHomeAgentAction, decideHomeCaptureAction } from "@/domains/home/actions";
import { answerRunQuestion, dismissQuestionAction } from "@/app/(workspace)/polymath/[runId]/question-actions";
import { triageTab, type TriageFeed, type TriageItem, type TriageTab } from "@/domains/notifications/feed";

/*
 * The notifications sheet, rebuilt as a zero-hop triage workspace (spec
 * art_psA7CtqO). Every card carries its native action inline: a question is
 * answered where it shows, a proposal is approved or rejected in one tap, and
 * a deep link lands on the exact entity. The tabs are the feed's own
 * classification (Inbox / In-Flight / Activity); audit telemetry left the
 * panel for /activity, whose Full history link the Activity tab carries.
 *
 * It is still a sheet, not a page, because these are interruptions: opening
 * one must not cost the owner their place. It closes itself on navigation -
 * the old sheet lingered on list pages and died headerless on /polymath/*,
 * where the TopBar unmounts; a deep link is now a clean full handoff.
 *
 * Cards are the shell/notifications atoms; the data is the triage feed. The
 * panel owns only selection, the open state, and the in-place actions, which
 * are the same guarded server actions the owning surfaces run.
 */

type QuestionItem = Extract<TriageItem, { kind: "question" }>;
type DecisionItem = Extract<TriageItem, { kind: "decision" }>;

const TAB_IDS: TriageTab[] = ["inbox", "inFlight", "activity"];

const EMPTY_COPY: Record<TriageTab, string> = {
  inbox: "Nothing needs you right now.",
  inFlight: "No runs in flight.",
  activity: "No finished runs yet.",
};

/** The selected option's DOM id; the reply input derives its id from it. */
function optionId(item: TriageItem): string {
  return `triage-${item.kind}-${item.id}`;
}

/** The question variant names its timestamp for the CAS row it came from. */
function itemAt(item: TriageItem): Date {
  return item.kind === "question" ? item.askedAt : item.at;
}

export function NotificationsPanel({ feed }: { feed: TriageFeed }) {
  const router = useRouter();
  const pathname = usePathname();
  const { notify } = useWorkspace();

  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<TriageTab>("inbox");
  const [selected, setSelected] = useState(0);
  // Cards removed after a successful action; covers the beat between the
  // transition ending and the refreshed server render dropping them - the
  // reviews queue's decidedCards overlay, in the shape this panel needs.
  const [settled, setSettled] = useState<ReadonlySet<string>>(() => new Set());
  const [items, applyRemove] = useOptimistic(feed.items, (current: TriageItem[], event: { id: string }) =>
    current.filter((candidate) => candidate.id !== event.id),
  );
  // Idempotency keys minted per proposal for its rendered lifetime: a retried
  // click replays the same key and the stored receipt answers it. A failed
  // decision refreshes from the server, so a bumped version re-mints.
  const decisionKeys = useRef<Record<string, string>>({});
  const [, startTransition] = useTransition();

  // Grouped by the feed's own classifier, so a card can never sit in a tab
  // the seam did not intend and the classification tests already pin.
  const byTab = useMemo(() => {
    const grouped: Record<TriageTab, TriageItem[]> = { inbox: [], inFlight: [], activity: [] };
    for (const item of items) grouped[triageTab(item)].push(item);
    return grouped;
  }, [items]);
  const visible = byTab[tab].filter((item) => !settled.has(item.id));
  const selectedId = visible.length > 0 ? optionId(visible[Math.min(selected, visible.length - 1)]) : undefined;

  // Close on navigation: a route change underneath the sheet is a handoff (an
  // Open link, Enter, the browser back button), not a reason to keep it up.
  // Adjusted during render (the React-recommended reset) rather than in an
  // effect, so the close lands in the same render as the route change.
  const [renderedPath, setRenderedPath] = useState(pathname);
  if (renderedPath !== pathname) {
    setRenderedPath(pathname);
    setOpen(false);
  }

  function moveSelection(delta: 1 | -1) {
    if (visible.length === 0) return;
    const next = Math.min(Math.max(selected + delta, 0), visible.length - 1);
    setSelected(next);
    document.getElementById(optionId(visible[next]))?.scrollIntoView({ block: "nearest" });
  }

  function openItem(item: TriageItem) {
    router.push(item.href);
  }

  function focusReply(item: TriageItem | undefined) {
    if (!item || item.kind !== "question") return;
    document.getElementById(`${optionId(item)}-reply`)?.focus();
  }

  function reply(item: QuestionItem, answer: string) {
    startTransition(async () => {
      applyRemove({ id: item.id });
      const result = await answerRunQuestion({ runId: item.runId, questionId: item.id, answer });
      if (!result.ok) {
        notify(result.message);
        router.refresh();
        return;
      }
      setSettled((prev) => new Set(prev).add(item.id));
      notify("Sent. The agent resumed.");
      router.refresh();
    });
  }

  function dismiss(item: QuestionItem) {
    startTransition(async () => {
      applyRemove({ id: item.id });
      const result = await dismissQuestionAction({ questionId: item.id });
      if (!result.ok) {
        notify(result.message);
        router.refresh();
        return;
      }
      setSettled((prev) => new Set(prev).add(item.id));
      notify("Question dismissed. The run stays parked.");
      router.refresh();
    });
  }

  function decide(item: DecisionItem, intent: "approve" | "reject") {
    startTransition(async () => {
      applyRemove({ id: item.id });
      const idempotencyKey = (decisionKeys.current[item.id] ??= crypto.randomUUID());
      const result =
        item.decision.decisionType === "action"
          ? await decideHomeAgentAction({
              idempotencyKey,
              proposalId: item.id,
              expectedVersion: item.decision.version,
              revisionId: item.decision.revisionId,
              decision: intent === "approve" ? "approved" : "rejected",
            })
          : await decideHomeCaptureAction({
              proposalId: item.id,
              decision: intent === "approve" ? "accepted" : "rejected",
            });
      if (!result.ok) {
        notify(result.error);
        router.refresh();
        return;
      }
      setSettled((prev) => new Set(prev).add(item.id));
      notify(intent === "approve" ? "Approved." : "Rejected.");
      router.refresh();
    });
  }

  // The command layer's pattern: one window listener, re-attached each render
  // so it reads the live selection, with a guard that leaves text fields (and
  // the controls Enter activates) alone. j/k move; r, e, and Enter act on the
  // selected card; e is a question's transition only, because Approve and
  // Reject are terminal and destructive.
  useEffect(() => {
    if (!open) return;
    const listener = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const el = event.target instanceof HTMLElement ? event.target : null;
      const typing = el !== null && (el.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName));
      if (event.key === "j" || event.key === "ArrowDown") {
        if (typing) return;
        event.preventDefault();
        moveSelection(1);
        return;
      }
      if (event.key === "k" || event.key === "ArrowUp") {
        if (typing) return;
        event.preventDefault();
        moveSelection(-1);
        return;
      }
      if (typing || el?.tagName === "BUTTON" || el?.tagName === "A") return;
      if (event.key === "r") {
        event.preventDefault();
        focusReply(visible[selected]);
        return;
      }
      if (event.key === "e") {
        event.preventDefault();
        const item = visible[selected];
        if (item?.kind === "question") dismiss(item);
        return;
      }
      if (event.key === "Enter") {
        event.preventDefault();
        const item = visible[selected];
        if (item) openItem(item);
      }
    };
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  });

  function card(item: TriageItem) {
    const id = optionId(item);
    const onOpen = () => openItem(item);
    const base = { id, askedAt: itemAt(item), selected: id === selectedId };
    switch (item.kind) {
      case "question":
        return (
          <NotificationCard
            key={`${item.kind}:${item.id}`}
            {...base}
            kind="question"
            questionText={item.questionText}
            context={item.context}
            onReply={(answer) => reply(item, answer)}
            onDismiss={() => dismiss(item)}
            onOpen={onOpen}
          />
        );
      case "decision":
        return (
          <NotificationCard
            key={`${item.kind}:${item.id}`}
            {...base}
            kind="decision"
            decisionType={item.decision.decisionType}
            title={item.title}
            detail={item.detail}
            expired={item.decision.decisionType === "action" && item.decision.expired}
            onDecide={(intent) => decide(item, intent)}
            onOpen={onOpen}
          />
        );
      case "run":
        return (
          <NotificationCard
            key={`${item.kind}:${item.id}`}
            {...base}
            kind="run"
            runState={item.runState}
            // The feed already applied the title policy (summary first,
            // objective label second), so the card's own preference is done.
            title={item.title}
            summary={null}
            detail={item.detail}
            onOpen={onOpen}
          />
        );
    }
  }

  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) setSelected(0);
      }}
    >
      <SheetTrigger asChild>
        <button
          type="button"
          aria-label={
            feed.counts.inbox > 0
              ? `Notifications, ${feed.counts.inbox} ${feed.counts.inbox === 1 ? "item needs" : "items need"} you`
              : "Notifications"
          }
          className="text-muted-foreground hover:bg-muted hover:text-foreground relative flex size-8 items-center justify-center rounded-md"
        >
          <Bell aria-hidden className="size-4" />
          {feed.counts.inbox > 0 ? (
            <span className="bg-primary text-primary-foreground absolute -top-0.5 -right-0.5 flex min-w-4 items-center justify-center rounded-full px-1 text-[10px] leading-4">
              {feed.counts.inbox > 99 ? "99+" : feed.counts.inbox}
            </span>
          ) : null}
        </button>
      </SheetTrigger>
      <SheetContent side="right" className="flex w-full flex-col gap-0 p-0 sm:max-w-md">
        <SheetHeader className="border-b border-border px-4 py-3">
          <SheetTitle className="text-[15px] font-medium">Notifications</SheetTitle>
          <SheetDescription className="text-[11px] text-muted-foreground">
            What needs you, what an agent is working on, and what already finished.
          </SheetDescription>
        </SheetHeader>

        <Tabs
          value={tab}
          onValueChange={(value) => {
            setTab(value as TriageTab);
            setSelected(0);
          }}
          className="min-h-0 flex-1"
        >
          <div className="border-b border-border px-3 py-2">
            <TabsList className="w-full">
              <TabsTrigger value="inbox">
                Inbox
                <span className="readout text-[11px] text-muted-foreground">{feed.counts.inbox}</span>
              </TabsTrigger>
              <TabsTrigger value="inFlight">
                In-Flight
                <span className="readout text-[11px] text-muted-foreground">{feed.counts.inFlight}</span>
              </TabsTrigger>
              <TabsTrigger value="activity">Activity</TabsTrigger>
            </TabsList>
          </div>

          {TAB_IDS.map((id) => {
            const tabItems = byTab[id].filter((item) => !settled.has(item.id));
            return (
              <TabsContent key={id} value={id} className="min-h-0 overflow-y-auto py-1">
                {tabItems.length === 0 ? (
                  <p className="px-4 py-8 text-center text-[12px] text-muted-foreground">{EMPTY_COPY[id]}</p>
                ) : (
                  <div
                    role="listbox"
                    aria-label="Notification cards"
                    aria-activedescendant={id === tab ? selectedId : undefined}
                    className="divide-y divide-border/60"
                  >
                    {tabItems.map((item) => card(item))}
                  </div>
                )}
                {id === "activity" ? (
                  <p className="px-4 py-3 text-[12px]">
                    {/* Audit telemetry lives here, not in the panel; the tab's
                        record is finished runs only. */}
                    <Link
                      href="/activity"
                      className="text-muted-foreground underline underline-offset-2 hover:text-foreground"
                    >
                      Full history
                    </Link>
                  </p>
                ) : null}
              </TabsContent>
            );
          })}
        </Tabs>
      </SheetContent>
    </Sheet>
  );
}
