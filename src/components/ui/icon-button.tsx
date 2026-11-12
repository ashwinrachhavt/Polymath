"use client";

import { AnimatePresence, motion } from "motion/react";
import { DropdownMenu, Tooltip } from "radix-ui";
import { MoreHorizontal } from "lucide-react";
import { useEffect, useId, useRef, useState, type ComponentProps, type ReactElement, type ReactNode } from "react";
import { cn } from "cn";
import { motionTransition } from "@/components/motion-config";
import { Button } from "@/components/ui/button";

/*
 * Compact verbs: an icon that names itself on hover and focus. A row of these
 * replaces a row of text buttons where space is short. The label is the
 * accessible name too, so a screen reader hears the same word the tooltip
 * shows. A disabled verb stays hoverable and says why it is off, instead of
 * going dead under the pointer.
 */

/** The hover/focus label around any single focusable element. */
function Hint({ label, children }: { label: ReactNode; children: ReactElement }) {
  return (
    <Tooltip.Provider delayDuration={250} skipDelayDuration={150}>
      <Tooltip.Root>
        <Tooltip.Trigger asChild>{children}</Tooltip.Trigger>
        <Tooltip.Portal>
          <Tooltip.Content
            side="top"
            sideOffset={6}
            collisionPadding={8}
            className="bg-foreground text-background data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=delayed-open]:animate-in data-[state=delayed-open]:fade-in-0 z-50 max-w-64 rounded-sm px-2 py-1 text-xs leading-snug motion-reduce:animate-none"
          >
            {label}
          </Tooltip.Content>
        </Tooltip.Portal>
      </Tooltip.Root>
    </Tooltip.Provider>
  );
}

type IconButtonProps = Omit<ComponentProps<typeof Button>, "size" | "children"> & {
  /** The verb, shown on hover and read as the button's name. */
  label: string;
  /** Shown instead of the label while the verb is disabled. */
  disabledReason?: string;
  icon: ReactNode;
};

export function IconButton({ label, disabledReason, icon, disabled, onClick, className, ...props }: IconButtonProps) {
  const reasonId = useId();
  const reason = disabled && disabledReason ? disabledReason : null;
  return (
    <Hint label={reason ?? label}>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label={label}
        // aria-disabled, not disabled: a disabled button takes no pointer
        // events, so its tooltip could never say why it is off.
        aria-disabled={disabled || undefined}
        aria-describedby={reason ? reasonId : undefined}
        onClick={disabled ? (event) => event.preventDefault() : onClick}
        className={cn("text-muted-foreground hover:text-foreground aria-disabled:opacity-45", className)}
        {...props}
      >
        {icon}
        {reason ? (
          <span id={reasonId} className="sr-only">
            {reason}
          </span>
        ) : null}
      </Button>
    </Hint>
  );
}

const ARMED_FOR_MS = 3_000;

/*
 * A verb that asks twice: the first click arms it (the icon turns
 * destructive and says what a second click does), the second click within a
 * few seconds confirms. Moving away, Escape or the timeout disarms it. Only
 * opacity and transform move.
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
    <Hint label={armed ? "Click again to confirm" : label}>
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
    </Hint>
  );
}

export type MenuItem = { label: string; icon?: ReactNode; onSelect: () => void; disabled?: boolean };

/** The secondary verbs behind one "More" icon. */
export function OverflowMenu({ label, items, disabled }: { label: string; items: MenuItem[]; disabled?: boolean }) {
  if (items.length === 0) return null;
  return (
    <DropdownMenu.Root modal={false}>
      <Hint label={label}>
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
      </Hint>
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
