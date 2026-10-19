import { getPreferences } from "@/domains/identity/preferences";
import { getAuthContext } from "@/lib/auth";
import Settings from "@/components/products/command-center/settings";

export const metadata = { title: "Settings · Polymath" };

/*
 * The four owner-facing preferences (timezone, week start, appearance,
 * motion) are server rows now, so the page loads them the same way every
 * other canonical surface does; the panels below save through actions.ts.
 */
export default async function SettingsPage() {
  const auth = await getAuthContext();
  const serverPreferences = await getPreferences(auth);
  return <Settings serverPreferences={serverPreferences} />;
}
