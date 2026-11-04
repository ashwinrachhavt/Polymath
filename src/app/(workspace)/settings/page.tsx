import { stat } from "node:fs/promises";
import { io } from "next/cache";
import { Suspense } from "react";
import { getDefaultProfile } from "@/domains/agents/queries";
import { getPreferences } from "@/domains/identity/preferences";
import { defaultRoots } from "@/lib/agent-artifacts/scan";
import { getAuthContext } from "@/lib/auth";
import { capabilityStatus } from "@/lib/capability-config";
import Settings, { type AgentRootStatus } from "@/components/products/command-center/settings";

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
 *
 * A deployment without Clerk keys AND without the dev-auth bypass has no
 * account behind this screen at all, so asking for auth throws and the whole
 * route fell into the error boundary - which hid the one panel (capabilities)
 * whose entire job is to describe a not-fully-configured deployment. In that
 * configuration the preferences stay browser-local and the capability panel
 * still renders. The dev bypass IS an account - every other surface and the
 * header mode toggle read and save its preferences row through the actions -
 * so branching on clerkConfigured alone made this page the one surface that
 * denied the account existed: the form saved against version 0 forever and
 * every save after the first conflicted.
 */

export async function SettingsSurface() {
  await io();
  const capabilities = capabilityStatus();
  // Ask for the account first and fall back to the preview only when there is
  // genuinely none. Testing the flags instead missed the keyless dev harness,
  // where Clerk is unconfigured (so no keys) yet getAuthContext still resolves
  // the dev owner: this page rendered the preview branch, the form posted
  // version 0 forever, and every save after the first was a CAS conflict.
  let auth;
  try {
    auth = await getAuthContext();
  } catch {
    return <Settings capabilities={capabilities} browserPreview />;
  }
  const serverPreferences = await getPreferences(auth);
  // Owner scope, same contract as actions.ts: a non-owner must not receive
  // the raw brief in the initial RSC payload either.
  const serverAssistantProfile = auth.role === "owner" ? await getDefaultProfile(auth) : null;
  // Where a project-page scan would read local agent sessions (Workbench D3).
  // Paths and presence only — the transcripts themselves never reach this page.
  const roots = defaultRoots();
  const agentRoots: AgentRootStatus[] = await Promise.all(
    [
      { source: "Claude Code" as const, path: roots["claude-code"] },
      { source: "Codex" as const, path: roots.codex },
    ].map(async (root) => {
      try {
        await stat(root.path);
        return { ...root, present: true };
      } catch {
        return { ...root, present: false };
      }
    }),
  );
  return (
    <Settings
      serverPreferences={serverPreferences}
      capabilities={capabilities}
      serverAssistantProfile={serverAssistantProfile}
      browserPreview={false}
      agentRoots={agentRoots}
    />
  );
}

/*
 * io() has to sit inside a Suspense boundary, not just inside the route:
 * cacheComponents prerenders the shell and rejects uncached data that blocks
 * it. Bare `await io()` in the page default still logs "encountered uncached
 * data during prerendering" and stalls navigation. Unlike connection(), io()
 * still permits the session App Shell to be prefetched.
 */
export default function SettingsPage() {
  return (
    <Suspense
      fallback={
        <p role="status" className="p-6 text-body-dense text-muted-foreground">
          Loading settings…
        </p>
      }
    >
      <SettingsSurface />
    </Suspense>
  );
}
