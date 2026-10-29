import { Suspense } from "react";
import { Screen } from "@/components/workspace/ui";
import { SpendingPanel } from "./spending-panel";

export const metadata = { title: "Spending · Polymath" };

/*
 * The canonical spending ledger. It lived as a tab inside Briefing; when
 * Briefing was removed this became a route of its own rather than a redirect
 * into a page that no longer exists.
 *
 * The panel is a dynamic read (auth context, the ledger); under
 * cacheComponents it sits inside a Suspense boundary so a navigation treats
 * the shell as cached and streams the ledger, rather than failing the route
 * with "encountered uncached data".
 */
export default function SpendingPage() {
  return (
    <Screen
      title="Spending"
      description="What the agents have spent, from recorded usage events. Unpriced work shows as unpriced, never as zero."
    >
      <Suspense fallback={<p role="status" className="p-6 text-[13px] text-muted-foreground">Loading the ledger…</p>}>
        <SpendingPanel />
      </Suspense>
    </Screen>
  );
}
