import { Skeleton } from "@/components/ui/skeleton";

/*
 * Matches the conversation layout, not the generic workspace skeleton: the
 * composer-to-conversation handoff replaces this in place, so the header and
 * message area hold their positions instead of the page reading as a reload.
 * The workspace group's loading.tsx is the fallback for other segments; this
 * one exists because the composer→run navigation is the suite's hottest swap.
 */
export default function Loading() {
  return (
    <div className="page-content flex flex-1 flex-col gap-4" aria-busy>
      <div className="flex items-center gap-3">
        <Skeleton className="h-4 w-16" />
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <Skeleton className="h-4 w-2/3" />
          <Skeleton className="h-3 w-24" />
        </div>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-4">
        <div className="ml-auto max-w-[85%]">
          <Skeleton className="h-10 w-64" />
        </div>
        <div className="max-w-[72ch] flex flex-col gap-2">
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-5/6" />
          <Skeleton className="h-4 w-2/3" />
        </div>
        <div className="mt-auto flex flex-col gap-2 border-t border-border pt-3">
          <Skeleton className="h-16 w-full" />
        </div>
      </div>
    </div>
  );
}
