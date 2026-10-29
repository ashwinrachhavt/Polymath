import type { NextConfig } from "next";
import { withEve } from "eve/next";

const nextConfig: NextConfig = {
  experimental: {
    agentUpgrade: "security",
  },
  async redirects() {
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
    return Object.entries(paths).map(([source, destination]) => ({ source: `/${source}`, destination, permanent: false }))
      .concat([
        {
          // Static root redirect. The former src/app/(workspace)/page.tsx
          // rendered redirect("/polymath") inside the dynamic (workspace) layout,
          // so every never-cacheable prefetch of it (side-nav wordmark) hit a
          // full dynamic render returning a redirect flight — the router
          // re-rendered and re-fetched "/" forever (the infinite GET / loop).
          // A config redirect bypasses the layout entirely.
          source: "/",
          destination: "/polymath",
          permanent: false,
        },
        // 2026-10-29 rename: every pre-rename bookmark lands on its renamed
        // route. The app-switcher prefix moved at the same time.
        { source: "/alfred/:path*", destination: "/polymath/:path*", permanent: false },
        { source: "/apps/alfred/:path*", destination: "/apps/polymath/:path*", permanent: false },
      ]);
  },
  cacheComponents: true,
  partialPrefetching: true,
  turbopack: {
    rules: {
      "*.css": {
        // ASH-135 s8: without the condition the glob also claims *.module.css,
        // compiling it as global CSS and silently dropping the module scoping.
        // Module files fall through to Turbopack's native CSS Modules handling.
        condition: { not: { path: /\.module\.css$/ } },
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

// Verified API shape: withEve(config, { agents: { <name>: { root } } }).
// polymath is the first-party chief-of-staff agent; specialist serves every
// hired specialist profile (the run's role brief arrives as client context).
export default withEve(nextConfig, {
  agents: { polymath: "./eve/polymath", specialist: "./eve/specialist" },
});
