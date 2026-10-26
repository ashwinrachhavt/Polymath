import { redirect } from "next/navigation";
import { getAuthContext } from "@/lib/auth";
import { getBriefing } from "@/domains/work/briefing";

/*
 * /command-center/day is the daybook's stable entry point. It had no path in
 * once the Briefing page that carried its "This day" link was removed, so the
 * bare route resolves to the workspace's current local date and redirects.
 *
 * `today` comes from getBriefing, which derives it in the workspace's own
 * timezone. Reading the server's date instead would show the wrong record for
 * most of the world around midnight.
 */
export default async function DayIndex() {
  const auth = await getAuthContext();
  const { today } = await getBriefing(auth);
  redirect(`/command-center/day/${today}`);
}
