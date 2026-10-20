import { connection } from "next/server";
import { Suspense } from "react";
import { getPreferences } from "@/domains/identity/preferences";
import { getAuthContext } from "@/lib/auth";
import Settings from "@/components/products/command-center/settings";

export const metadata = { title: "Settings · Polymath" };

/*
 * The four owner-facing preferences (timezone, week start, appearance,
 * motion) are server rows now, so the page loads them the same way every
 * other canonical surface does; the panels below save through actions.ts.
 */

async function Preferences() {
  await connection();
  const auth = await getAuthContext();
  const serverPreferences = await getPreferences(auth);
  return <Settings serverPreferences={serverPreferences} />;
}

/*
 * connection() has to sit inside a Suspense boundary, not just inside the
 * route: cacheComponents prerenders the shell and rejects uncached data that
 * blocks it. Bare `await connection()` in the page default still logs
 * "encountered uncached data during prerendering" and stalls navigation.
 */
export default function SettingsPage() {
  return (
    <Suspense fallback={<p role="status" className="p-6 text-[13px] text-muted-foreground">Loading settings…</p>}>
      <Preferences />
    </Suspense>
  );
}
