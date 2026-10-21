import Link from "next/link";
import { Empty } from "@/components/workspace/ui";

/** Distinguishes "nothing here yet" from "your filters hide everything". */
export function NoResults({
  filtered,
  clearHref,
  emptyTitle,
  emptyDescription,
}: {
  filtered: boolean;
  clearHref: string;
  emptyTitle: string;
  emptyDescription?: string;
}) {
  if (!filtered) return <Empty title={emptyTitle} description={emptyDescription} />;
  return (
    <Empty
      title="No matches"
      description="Nothing fits the current search and filters."
      action={
        <Link href={clearHref} className="text-[13px] font-medium underline underline-offset-4">
          Clear filters
        </Link>
      }
    />
  );
}
