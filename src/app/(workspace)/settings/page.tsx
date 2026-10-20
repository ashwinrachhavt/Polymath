import { getPreferences } from "@/domains/identity/preferences";
import { getAuthContext } from "@/lib/auth";
import { capabilityStatus } from "@/lib/capability-config";
import Settings from "@/components/products/command-center/settings";

export const metadata = { title: "Settings · Polymath" };

/*
 * The four owner-facing preferences (timezone, week start, appearance,
 * motion) are server rows now, so the page loads them the same way every
 * other canonical surface does; the panels below save through actions.ts.
 *
 * Capability state is read on the server and passed down: which integrations
 * this deployment has keys for is a server fact, and the panel names the
 * missing variables instead of rendering a control that silently does nothing
 * (ASH-193). Only variable names cross to the client, never values.
 */
export default async function SettingsPage() {
  const auth = await getAuthContext();
  const serverPreferences = await getPreferences(auth);
  const capabilities = capabilityStatus();
  return <Settings serverPreferences={serverPreferences} capabilities={capabilities} />;
}
