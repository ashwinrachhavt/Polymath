import { redirect } from "next/navigation";

/*
 * Briefing is gone: its day context, outcome picking and theatre did not earn
 * a surface, and the decisions it carried already have homes. The day record
 * and the shutdown ritual moved to their own routes; the spending ledger moved
 * to /command-center/spending.
 *
 * This bridge stays because the path is in the mobile bar's history and in
 * shell bookmarks. It points at Work's Today view, which is where the question
 * Briefing answered now lives.
 */
export default function BriefingPage() {
  redirect("/neuralflow/work?view=today");
}
