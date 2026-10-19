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
 * is fixed here.
 */
export function Select({ className = "", children, ...props }: ComponentProps<"select">) {
  // Width and flex utilities belong on the wrapper so the arrow stays inside
  // the visible control. Keep colour, border and text overrides on the select.
  const layout = className.split(/\s+/).filter((token) => /^(?:(?:sm|md|lg|xl|2xl):)*(?:(?:min-|max-)?w-|flex-)/.test(token)).join(" ");
  const hasWidth = /(?:^|\s)w-/.test(layout);
  return (
    <span data-slot="select-wrapper" className={`relative inline-flex min-w-0 ${hasWidth ? "" : "w-full"} ${layout}`}>
      <select
        {...props}
        data-slot="select"
        className={`h-9 w-full min-w-0 appearance-none rounded-md border border-input bg-background pr-8 pl-2.5 text-[13px] outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 ${className}`}
      >
        {children}
      </select>
      <ChevronDown aria-hidden className="text-muted-foreground pointer-events-none absolute top-1/2 right-2 size-4 -translate-y-1/2" />
    </span>
  );
}
