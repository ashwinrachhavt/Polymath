import { Skeleton } from "@/components/ui/skeleton";

/*
 * The briefing composes several domain reads, so its first paint is a skeleton
 * rather than a jump. Three rows is the shape of the outcome list it resolves
 * into; it is not a generic spinner because a spinner tells the owner nothing
 * about what is coming.
 */
export default function Loading() {
  return (
    <main
      aria-busy
      className="mx-auto flex w-full max-w-2xl flex-1 flex-col justify-center gap-3 p-6"
    >
      <Skeleton className="h-7 w-32" />
      <Skeleton className="h-4 w-full max-w-prose" />
      <div className="flex flex-col gap-2">
        <Skeleton className="h-4 w-2/3" />
        <Skeleton className="h-4 w-1/2" />
        <Skeleton className="h-4 w-3/5" />
      </div>
    </main>
  );
}
