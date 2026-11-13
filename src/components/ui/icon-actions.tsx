"use client";

import { AnimatePresence, motion } from "motion/react";
import { DropdownMenu } from "radix-ui";
import { MoreHorizontal } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "cn";
import { motionTransition } from "@/components/motion-config";
import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/tooltip";

/*
 * Icon verbs that need more than IconButton: one that asks twice before a
 * reversible-but-noisy action (archive), and the "More" menu that holds the
 * secondary verbs of a crowded row. Delete has its own button; use
 * DeleteButton there.
 */

const ARMED_FOR_MS = 3_000;

/*
 * The first click arms it (the icon turns destructive and says what a second
 * click does), the second click within a few seconds confirms. Moving away,
 * Escape or the timeout disarms it. Only opacity and transform move.
 */
export function ConfirmIconButton({
  label,
  confirmLabel,
  icon,
  disabled,
  onConfirm,
}: {
  label: string;
  /** What the armed button says, e.g. "Archive?". */
  confirmLabel: string;
  icon: ReactNode;
  disabled?: boolean;
  onConfirm: () => void;
}) {
  const [armed, setArmed] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!armed) return;
    timer.current = setTimeout(() => setArmed(false), ARMED_FOR_MS);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [armed]);

  return (
    <Tooltip content={armed ? "Click again to confirm" : label} side="top">
      <Button
        type="button"
        variant={armed ? "destructive" : "ghost"}
        size="sm"
        aria-label={armed ? `${confirmLabel} Click again to confirm.` : label}
        aria-disabled={disabled || undefined}
        data-armed={armed || undefined}
        onClick={() => {
          if (disabled) return;
          if (!armed) {
            setArmed(true);
            return;
          }
          setArmed(false);
          onConfirm();
        }}
        onBlur={() => setArmed(false)}
        onKeyDown={(event) => {
          if (event.key === "Escape") setArmed(false);
        }}
        className={cn(
          "min-w-7 px-1.5 aria-disabled:opacity-45",
          !armed && "text-muted-foreground hover:text-foreground",
        )}
      >
        {icon}
        <AnimatePresence initial={false}>
          {armed ? (
            <motion.span
              key="confirm"
              initial={{ opacity: 0, x: -4 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0 }}
              transition={motionTransition}
              className="text-xs font-medium"
            >
              {confirmLabel}
            </motion.span>
          ) : null}
        </AnimatePresence>
      </Button>
    </Tooltip>
  );
}

export type MenuItem = { label: string; icon?: ReactNode; onSelect: () => void; disabled?: boolean };

/** The secondary verbs behind one "More" icon. */
export function OverflowMenu({ label, items, disabled }: { label: string; items: MenuItem[]; disabled?: boolean }) {
  if (items.length === 0) return null;
  return (
    <DropdownMenu.Root modal={false}>
      <Tooltip content={label} side="top">
        <DropdownMenu.Trigger asChild disabled={disabled}>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={label}
            className="text-muted-foreground hover:text-foreground"
          >
            <MoreHorizontal aria-hidden />
          </Button>
        </DropdownMenu.Trigger>
      </Tooltip>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          sideOffset={6}
          collisionPadding={8}
          className="panel bg-popover text-popover-foreground shadow-raised data-[state=open]:animate-in data-[state=open]:fade-in-0 z-50 min-w-44 rounded-md p-1 outline-none motion-reduce:animate-none"
        >
          <DropdownMenu.Label className="text-muted-foreground px-2 pt-1 pb-1.5 text-xs">{label}</DropdownMenu.Label>
          {items.map((item) => (
            <DropdownMenu.Item
              key={item.label}
              disabled={item.disabled}
              onSelect={item.onSelect}
              className="data-[highlighted]:bg-muted flex cursor-default items-center gap-2 rounded-sm px-2 py-1.5 text-body-dense outline-none select-none data-[disabled]:opacity-45 [&_svg]:size-3.5 [&_svg]:shrink-0"
            >
              {item.icon}
              {item.label}
            </DropdownMenu.Item>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
