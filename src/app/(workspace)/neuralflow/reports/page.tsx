import { Screen } from "@/components/workspace/ui";
import { KnowledgeDebtPanel, OutcomeNarrativePanel, ServerWeek } from "./server-week";

export const metadata = { title: "Reports · Polymath" };

/*
 * The weekly review, from your account: this week's completions and focus
 * (D15), the week in your own words (ASH-280) and the knowledge debt
 * (ASH-295). These panels used to sit on top of the browser-local preview
 * Reports screen under /apps; that preview half is gone, and the old URL
 * redirects here.
 */
export default function ReportsPage() {
  return (
    <Screen title="Reports" description="Your week, counted from what your account recorded.">
      <ServerWeek />
      <OutcomeNarrativePanel />
      <KnowledgeDebtPanel />
    </Screen>
  );
}
