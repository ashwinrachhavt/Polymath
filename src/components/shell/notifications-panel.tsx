"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Bell } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import type { Notification, NotificationFeed, NotificationKind } from "@/domains/notifications/feed";
import { decideHomeAgentAction, decideHomeCaptureAction } from "@/domains/home/actions";

/*
 * The notifications panel: everything that needs the owner, behind one trigger
 * in the header and never on screen until opened.
 *
 * It is a sheet, not a page, because these are interruptions to whatever the
 * owner is doing - opening one must not cost them their place. Decisions are
 * answered here in one tap (the same guarded actions the owning surface runs);
 * runs and audit rows link to their own surface rather than duplicating it.
 */

const TABS: { id: "all" | NotificationKind; label: string }[] = [
  { id: "all", label: "All" },
  { id: "decision", label: "Decisions" },
  { id: "run", label: "Runs" },
  { id: "audit", label: "Audit" },
];

const RISK_TONE: Record<NotificationKind, string> = {
  decision: "text-primary",
  run: "text-muted-foreground",
  audit: "text-muted-foreground",
};

function relative(at: Date): string {
  const minutes = Math.round((Date.now() - at.getTime()) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export function NotificationsPanel({ feed }: { feed: NotificationFeed }) {
  const [tab, setTab] = useState<"all" | NotificationKind>("all");
  const items = tab === "all" ? feed.items : feed.items.filter((item) => item.kind === tab);
  const empty = items.length === 0;

  return (
    <Sheet>
      <SheetTrigger asChild>
        <button
          type="button"
          aria-label={
            feed.needsAction > 0
              ? `Notifications, ${feed.needsAction} ${feed.needsAction === 1 ? "item needs" : "items need"} you`
              : "Notifications"
          }
          className="text-muted-foreground hover:bg-muted hover:text-foreground relative flex size-8 items-center justify-center rounded-md"
        >
          <Bell aria-hidden className="size-4" />
          {feed.needsAction > 0 ? (
            <span className="bg-primary text-primary-foreground absolute -top-0.5 -right-0.5 flex min-w-4 items-center justify-center rounded-full px-1 text-[10px] leading-4">
              {feed.needsAction > 99 ? "99+" : feed.needsAction}
            </span>
          ) : null}
        </button>
      </SheetTrigger>
      <SheetContent side="right" className="flex w-full flex-col gap-0 p-0 sm:max-w-md">
        <SheetHeader className="border-b border-border px-4 py-3">
          <SheetTitle className="text-[15px] font-medium">Notifications</SheetTitle>
          <SheetDescription className="text-[11px] text-muted-foreground">
            Decisions waiting on you, agent runs in flight, and what the workspace recorded.
          </SheetDescription>
        </SheetHeader>

        <nav aria-label="Notification kinds" className="flex gap-1 border-b border-border px-3 py-2">
          {TABS.map(({ id, label }) => {
            const count = id === "all" ? feed.items.length : feed.counts[id];
            const current = tab === id;
            return (
              <button
                key={id}
                type="button"
                onClick={() => setTab(id)}
                aria-pressed={current}
                className={`rounded px-2 py-1 text-[12px] transition-colors ${
                  current ? "bg-muted font-medium text-foreground" : "text-muted-foreground hover:text-foreground"
                }`}
              >
                {label}
                <span className="readout ml-1.5 text-[11px] text-muted-foreground">{count}</span>
              </button>
            );
          })}
        </nav>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {empty ? (
            <p className="px-4 py-8 text-center text-[12px] text-muted-foreground">
              {tab === "decision"
                ? "Nothing needs your call."
                : tab === "run"
                  ? "No runs in flight."
                  : tab === "audit"
                    ? "Nothing recorded yet."
                    : "Nothing needs you right now."}
            </p>
          ) : (
            <ul className="divide-y divide-border/60">
              {items.map((item) => (
                <NotificationRow key={`${item.kind}:${item.id}`} item={item} />
              ))}
            </ul>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

function NotificationRow({ item }: { item: Notification }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");

  async function decide(decision: "approved" | "rejected" | "accepted") {
    if (!item.decision) return;
    setPending(true);
    setError("");
    const result =
      item.decision.kind === "agent"
        ? await decideHomeAgentAction({
            idempotencyKey: crypto.randomUUID(),
            proposalId: item.decision.proposalId,
            expectedVersion: item.decision.version,
            revisionId: item.decision.revisionId,
            decision: decision === "rejected" ? "rejected" : "approved",
          })
        : await decideHomeCaptureAction({
            proposalId: item.decision.proposalId,
            decision: decision === "rejected" ? "rejected" : "accepted",
          });
    setPending(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    router.refresh();
  }

  const expired = item.decision?.kind === "agent" && item.decision.expired;

  return (
    <li className="px-4 py-3">
      <div className="flex items-baseline gap-2">
        <span className={`text-[11px] font-medium ${RISK_TONE[item.kind]}`}>{item.state}</span>
        <span className="readout ml-auto shrink-0 text-[11px] text-muted-foreground">{relative(item.at)}</span>
      </div>
      <p className="mt-1 text-[13px] leading-snug text-foreground">{item.title}</p>
      {item.detail ? <p className="mt-0.5 text-[12px] leading-relaxed text-muted-foreground">{item.detail}</p> : null}
      <div className="mt-1.5 flex items-center gap-1.5">
        {item.decision && !expired ? (
          <>
            <Button type="button" size="sm" disabled={pending} onClick={() => decide("approved")}>
              Approve
            </Button>
            <Button type="button" size="sm" variant="outline" disabled={pending} onClick={() => decide("rejected")}>
              Reject
            </Button>
          </>
        ) : null}
        {item.href ? (
          <Button asChild size="sm" variant="ghost">
            <Link href={item.href}>{item.decision ? "Open" : "View"}</Link>
          </Button>
        ) : null}
        {expired ? <span className="text-[11px] text-muted-foreground">Expired; open it to re-propose.</span> : null}
        {error ? <span role="alert" className="text-[11px] text-destructive">{error}</span> : null}
      </div>
    </li>
  );
}
