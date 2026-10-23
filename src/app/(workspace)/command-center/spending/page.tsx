import { redirect } from "next/navigation";

// Spending left the rail in the IA simplification; it is a Briefing tab now.
export default function SpendingPage() {
  redirect("/command-center/briefing?tab=spending");
}
