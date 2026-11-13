"use client";

import Link from "next/link";
import { useId, type ComponentProps, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Tooltip, type TooltipSide } from "@/components/ui/tooltip";

type IconSize = "icon" | "icon-xs" | "icon-sm" | "icon-lg";

type Common = {
  /** The accessible name and the tooltip text: a verb phrase, sentence case ("Delete note"). */
  label: string;
  icon: ReactNode;
  /** Key hint shown in the tooltip and exposed as aria-keyshortcuts. */
  shortcut?: string;
  side?: TooltipSide;
  size?: IconSize;
  variant?: ComponentProps<typeof Button>["variant"];
  className?: string;
};

type AsButtonOnly = {
  /**
   * Said in the tooltip, and read after the name, while the control is
   * disabled. A disabled control stays hoverable (aria-disabled, not
   * disabled) so it can say why it is off instead of going dead.
   */
  disabledReason?: string;
};

type AsButton = Common &
  AsButtonOnly &
  Omit<ComponentProps<"button">, "children" | "aria-label" | keyof Common | keyof AsButtonOnly> & { href?: undefined };

type AsLink = Common & { href: string; prefetch?: boolean; target?: string };

/*
 * An icon-only control with a name. `label` is both the aria-label and the
 * hover/focus tooltip, so an icon can never ship unnamed and the hint can
 * never drift from what a screen reader hears. Pass `href` for navigation
 * (a real link) and `onClick` for an action (a real button).
 *
 * Use a labelled Button instead when the icon alone would be ambiguous:
 * the page's primary action, or a verb with no settled glyph.
 */
export function IconButton(props: AsButton | AsLink) {
  const named = (label: string, shortcut: string | undefined) => ({
    "aria-label": label,
    "aria-keyshortcuts": shortcut,
  });

  if (props.href !== undefined) {
    const { label, icon, shortcut, side, size = "icon", variant = "ghost", className, href, prefetch, target } = props;
    return (
      <Tooltip content={label} shortcut={shortcut} side={side}>
        <Button asChild variant={variant} size={size} className={className}>
          <Link href={href} prefetch={prefetch} target={target} {...named(label, shortcut)}>
            {icon}
          </Link>
        </Button>
      </Tooltip>
    );
  }

  return <ButtonIcon {...props} />;
}

function ButtonIcon({
  label,
  icon,
  shortcut,
  side,
  size = "icon",
  variant = "ghost",
  type = "button",
  disabled,
  disabledReason,
  onClick,
  ...buttonProps
}: AsButton) {
  const reasonId = useId();
  const reason = disabled && disabledReason ? disabledReason : null;
  return (
    <Tooltip content={reason ?? label} shortcut={reason ? undefined : shortcut} side={side}>
      <Button
        type={type}
        variant={variant}
        size={size}
        {...buttonProps}
        aria-label={label}
        aria-keyshortcuts={shortcut}
        // aria-disabled, not disabled, when there is a reason: a disabled
        // button takes no pointer events, so its tooltip could never say why.
        disabled={reason ? undefined : disabled}
        aria-disabled={reason ? true : undefined}
        aria-describedby={reason ? reasonId : buttonProps["aria-describedby"]}
        onClick={reason ? (event) => event.preventDefault() : onClick}
      >
        {icon}
        {reason ? (
          <span id={reasonId} className="sr-only">
            {reason}
          </span>
        ) : null}
      </Button>
    </Tooltip>
  );
}
