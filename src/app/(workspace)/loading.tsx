import { Skeleton } from "@/components/ui/skeleton";

/*
 * In-shell navigation feedback for every workspace destination: the chrome
 * (rail, header, mobile bar) is already on screen from the shell, so this
 * skeleton fills only the content well. It renders no <main> and no heading -
 * the shell owns both - which keeps landmark counts stable for assistive tech
 * and for the e2e smoke checks that scope to #content.
 */
export default function Loading() {
  return (
    <div role="status" aria-label="Loading page" className="flex flex-1 flex-col gap-4 p-6">
      <Skeleton className="h-6 w-40" />
      <Skeleton className="h-4 w-full max-w-xl" />
      <Skeleton className="h-24 w-full" />
    </div>
  );
}
