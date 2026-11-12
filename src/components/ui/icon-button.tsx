"use client";

import Link from "next/link";
import type { ComponentProps, ReactNode } from "react";
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

type AsButton = Common &
  Omit<ComponentProps<"button">, "children" | "aria-label" | keyof Common> & { href?: undefined };

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

  const { label, icon, shortcut, side, size = "icon", variant = "ghost", type = "button", ...buttonProps } = props;
  return (
    <Tooltip content={label} shortcut={shortcut} side={side}>
      <Button type={type} variant={variant} size={size} {...buttonProps} {...named(label, shortcut)}>
        {icon}
      </Button>
    </Tooltip>
  );
}
