/*
 * The legacy bookmark redirect table for next.config.ts, extracted to the
 * repo root (deliberately outside src/) so the root redirect's arming
 * condition is unit-testable without invoking withEve's returned config
 * function — next.config's default export is that function, and calling it
 * drags in eve's build-time side effects. Keeping the table outside src/
 * also keeps the rename-sweep audit's simple rule intact: /alfred appears
 * in source files only as redirect destinations' history, never as code.
 */
import { proxyArmed } from "./src/lib/clerk";

export function nextConfigRedirects({
  includeStaticRootRedirect = !proxyArmed,
}: {
  includeStaticRootRedirect?: boolean;
} = {}): Array<{ source: string; destination: string; permanent: boolean }> {
  // Reviews, Activity, and Settings are shared routes (spec § The suite):
  // real pages at their canonical unprefixed paths, so no redirect here —
  // shadowing them sent the header's Reviews shield to the legacy preview.
  // The rest keep their pre-split bookmark compatibility.
  const paths: Record<string, string> = {
    briefing: "/apps/command-center/briefing", inbox: "/apps/command-center/inbox",
    work: "/apps/neuralflow/tasks", focus: "/apps/neuralflow/focus",
    // /polymath keeps its workspace page: the run UI (start a run, recent
    // runs) is server-rendered there. The lens chat screen stays at
    // /apps/polymath/chat for lens navigation.
    // Knowledge and Dossiers have real Neon-backed workspace screens, so their
    // legacy bare paths go there, not to the sample lens preview.
    knowledge: "/polymath/knowledge", dossiers: "/polymath/dossiers",
    relationships: "/apps/command-center/contacts", opportunities: "/apps/command-center/opportunities",
  };
  const redirects = Object.entries(paths).map(([source, destination]) => ({ source: `/${source}`, destination, permanent: false }))
    .concat([
      // 2026-10-29 rename: every pre-rename bookmark lands on its renamed
      // route. The app-switcher prefix moved at the same time.
      { source: "/alfred/:path*", destination: "/polymath/:path*", permanent: false },
      { source: "/apps/alfred/:path*", destination: "/apps/polymath/:path*", permanent: false },
    ]);
  // Static root redirect, kept only while the proxy is a pass-through
  // (proxyArmed false). The former src/app/(workspace)/page.tsx rendered
  // redirect("/polymath") inside the dynamic (workspace) layout, so every
  // never-cacheable prefetch of it (side-nav wordmark) hit a full dynamic
  // render returning a redirect flight — the router re-rendered and
  // re-fetched "/" forever (the infinite GET / loop). A config redirect
  // bypasses the layout entirely — but config redirects also run BEFORE
  // the proxy, so once the proxy is armed one would stand between the
  // signed-out root and the proxy's single hop to /landing (QA F9); the
  // armed proxy decides the root itself (src/proxy.ts).
  if (includeStaticRootRedirect) {
    redirects.push({ source: "/", destination: "/polymath", permanent: false });
  }
  return redirects;
}
