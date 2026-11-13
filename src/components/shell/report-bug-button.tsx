"use client";

import { Bug } from "lucide-react";
import { usePathname } from "next/navigation";
import { Popover } from "radix-ui";
import { useState } from "react";
import { IconButton } from "@/components/ui/icon-button";
import { toast } from "@/components/ui/toast";
import { reportBugAction } from "@/components/shell/report-bug-actions";
import type { ReportKind } from "@/domains/bug-triage/signal";
import { readLastErrorId } from "@/lib/last-error";

const KINDS: Array<{ kind: ReportKind; label: string }> = [
  { kind: "broken", label: "Something broke" },
  { kind: "wrong", label: "Something looks wrong" },
  { kind: "slow", label: "It is too slow" },
];

/*
 * One icon in the header. Picking what went wrong sends the current route
 * and the last error id - nothing on the page - and the bug agent turns
 * reports into GitHub issues.
 */
export function ReportBugButton() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [sending, setSending] = useState(false);

  async function send(kind: ReportKind) {
    setSending(true);
    try {
      const result = await reportBugAction({ route: pathname, errorId: readLastErrorId(), kind });
      if (result.ok) {
        setOpen(false);
        toast("Thanks. The report was sent.");
      } else {
        toast(result.error, { tone: "error" });
      }
    } catch {
      toast("Could not send the report. Try again.", { tone: "error" });
    } finally {
      setSending(false);
    }
  }

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <IconButton label="Report a bug" icon={<Bug aria-hidden />} className="text-muted-foreground" />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="end"
          sideOffset={6}
          collisionPadding={8}
          className="panel z-50 flex w-60 flex-col gap-1 rounded-lg bg-popover p-2 text-popover-foreground outline-none"
        >
          <p className="px-2 pt-1 pb-1.5 text-xs text-muted-foreground">
            Sends this page&apos;s address and the last error code. Nothing you wrote is included.
          </p>
          {KINDS.map(({ kind, label }) => (
            <button
              key={kind}
              type="button"
              disabled={sending}
              onClick={() => void send(kind)}
              className="flex h-8 items-center rounded-md px-2 text-left text-sm outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
            >
              {label}
            </button>
          ))}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
