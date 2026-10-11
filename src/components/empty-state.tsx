import type { ReactNode } from "react";

/*
 * An empty screen is an invitation to act, never a mood (agents/product.md).
 * The description says what will fill the space and how it gets there; if the
 * screen cannot show data yet, the action area says which connection is
 * missing rather than rendering an empty list as though the answer were none.
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
    <div className="border-border flex flex-col items-start gap-1 rounded-xl border border-dashed px-4 py-5">
      <p className="text-sm font-medium">{title}</p>
      <p className="text-muted-foreground max-w-prose text-sm">{description}</p>
      {action}
    </div>
  );
}
