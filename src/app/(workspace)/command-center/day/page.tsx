import { redirect } from "next/navigation";
import { getAuthContext } from "@/lib/auth";
import { todayIn } from "@/domains/daybook/queries";

/*
 * /command-center/day is the daybook's stable entry point. It had no path in
 * once the Briefing page that carried its "This day" link was removed, so the
 * bare route resolves to the workspace's current local date and redirects.
 *
 * "Today" comes from the daybook's own derivation, in the owner's timezone —
 * the server's date would show the wrong record for most of the world around
 * midnight.
 */
export default async function DayIndex() {
  const auth = await getAuthContext();
  redirect(`/command-center/day/${await todayIn(auth)}`);
}
