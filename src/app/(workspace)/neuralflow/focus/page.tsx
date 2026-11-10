import { Suspense } from "react";
import { Screen } from "@/components/workspace/ui";
import { FocusTimer } from "./focus-timer";

export const metadata = { title: "Focus · Polymath" };

/*
 * io() has to sit inside a Suspense boundary, not just inside the route:
 * cacheComponents prerenders the shell and rejects uncached data that blocks
 * it. A bare `await io()` in the page default logs "encountered uncached data
 * during prerendering" and stalls navigation (see settings/page.tsx).
 */
export default function FocusPage() {
  return (
    <Screen title="Focus" description="Run a strict focus session.">
      <Suspense
        fallback={
          <p role="status" className="text-body-dense text-muted-foreground">
            Loading focus…
          </p>
        }
      >
        <FocusTimer />
      </Suspense>
    </Screen>
  );
}
