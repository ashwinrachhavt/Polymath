import { Screen } from "@/components/workspace/ui";
import { SpendingPanel } from "./spending-panel";

export const metadata = { title: "Spending · Polymath" };

/*
 * The canonical spending ledger. It lived as a tab inside Briefing; when
 * Briefing was removed this became a route of its own rather than a redirect
 * into a page that no longer exists.
 */
export default function SpendingPage() {
  return (
    <Screen
      title="Spending"
      description="What the agents have spent, from recorded usage events. Unpriced work shows as unpriced, never as zero."
    >
      <SpendingPanel />
    </Screen>
  );
}
