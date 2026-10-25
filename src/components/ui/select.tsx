import { ChevronDown } from "lucide-react";
import type { ComponentProps } from "react";

/*
 * The one native select. Every picker in the product renders through this so
 * the control matches the inputs around it and the chevron never clips:
 * appearance-none removes the platform arrow, pr-8 reserves its space, and
 * the chevron is an icon, not a browser afterthought (ASH-169).
 *
 * Still a real <select> underneath: form posts, autofill, and mobile pickers
 * keep working. Pass layout utilities (width) via className; the base look
 * is fixed here. `ghost` is the toolbar variant: no frame, one hover fill,
 * and a shorter 32px body so it sits level with icon buttons and chips.
 */
export type SelectVariant = "default" | "ghost";

export function Select({
  className = "",
  variant = "default",
  children,
  ...props
}: ComponentProps<"select"> & { variant?: SelectVariant }) {
  // Width and flex utilities belong on the wrapper so the arrow stays inside
  // the visible control. Keep colour, border and text overrides on the select.
  const isLayout = (token: string) => /^(?:(?:sm|md|lg|xl|2xl):)*(?:(?:min-|max-)?w-|flex-)/.test(token);
  const tokens = className.split(/\s+/).filter(Boolean);
  const layout = tokens.filter(isLayout).join(" ");
  // The select always fills its wrapper; repeating width utilities on it made
  // `w-auto`/`flex-1` shrink the control inside a wider wrapper.
  const selectClass = tokens.filter((token) => !isLayout(token)).join(" ");
  const hasWidth = /(?:^|\s)w-/.test(layout);
  const base =
    variant === "ghost"
      ? "h-8 w-full min-w-0 appearance-none rounded-md border border-transparent bg-transparent pr-7 pl-2.5 text-[13px] text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
      : "h-9 w-full min-w-0 appearance-none rounded-md border border-input bg-background pr-8 pl-2.5 text-[13px] outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50";
  return (
    <span data-slot="select-wrapper" className={`relative inline-flex min-w-0 ${hasWidth ? "" : "w-full"} ${layout}`}>
      <select {...props} data-slot="select" data-variant={variant} className={`${base} ${selectClass}`}>
        {children}
      </select>
      <ChevronDown aria-hidden className="text-muted-foreground pointer-events-none absolute top-1/2 right-2 size-4 -translate-y-1/2" />
    </span>
  );
}
