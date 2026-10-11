import type { Review } from "@/components/workspace/types";

export function canDecideReview(current: Review | undefined, displayed: Review, input: { payload: string; reason: string; decision: "Approved locally" | "Rejected"; confirmed: boolean; sensitiveConfirmed: boolean }) {
  return !!current && current.id === displayed.id && current.revision === displayed.revision && current.payload === displayed.payload && current.status === "Pending" && input.payload === displayed.payload && !!input.reason.trim() && (input.decision === "Rejected" || (input.confirmed && (displayed.risk !== "Sensitive write" || input.sensitiveConfirmed)));
}
