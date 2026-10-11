import type { ReactNode } from "react";

/*
 * An empty screen is an invitation to act, never a mood (agents/product.md).
 * The description says what will fill the space and how it gets there; if the
 * screen cannot show data yet, the action area says which connection is
 * missing rather than rendering an empty list as though the answer were none.
 *
 * `.panel-empty` gives it the same machined edge as a loaded panel, dashed
 * instead of drawn. That is deliberate: the surface is the same object, so an
 * empty screen reads as a plate waiting for its part rather than as a hole.
 */
export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="panel-empty flex flex-col items-start gap-1.5 rounded-lg px-3.5 py-4">
      <p className="text-[13px] font-medium">{title}</p>
      <p className="text-muted-foreground max-w-prose text-[13px] leading-relaxed">
        {description}
      </p>
      {action}
    </div>
  );
}
