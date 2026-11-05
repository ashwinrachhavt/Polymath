import { Skeleton } from "@/components/ui/skeleton";

/*
 * The true first paint of a cold load: while the root is resolving, the
 * workspace layout (auth + its cached shell reads) has not rendered yet, so
 * this skeleton is all the server can promise. It stays neutral on purpose —
 * it previews the shell's shape (a bar over a content well), not any one
 * page's content, because which page is coming is not known here. The old
 * briefing-shaped skeleton promised a screen that is now a redirect bridge.
 */
export default function Loading() {
  return (
    <main aria-busy className="flex min-h-dvh flex-col">
      <Skeleton className="h-12 shrink-0 rounded-none" />
      <div className="flex flex-1 flex-col gap-4 p-6">
        <Skeleton className="h-6 w-40" />
        <Skeleton className="h-4 w-full max-w-xl" />
        <Skeleton className="h-24 w-full" />
      </div>
    </main>
  );
}
