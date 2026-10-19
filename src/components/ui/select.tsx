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
  return (
    <span className={`relative inline-flex ${className.includes("w-") ? "" : "w-full"}`}>
      <select
        {...props}
        className={`h-9 w-full min-w-0 appearance-none rounded-md border border-input bg-background pr-8 pl-2 text-[13px] outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 ${className}`}
      >
        {children}
      </select>
      <ChevronDown aria-hidden className="text-muted-foreground pointer-events-none absolute top-1/2 right-2 size-4 -translate-y-1/2" />
    </span>
  );
}
