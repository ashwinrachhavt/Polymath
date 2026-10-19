import type { NextConfig } from "next";
import { withEve } from "eve/next";

const nextConfig: NextConfig = {
  async redirects() {
    // Reviews, Activity, and Settings are shared routes (spec § The suite):
    // real pages at their canonical unprefixed paths, so no redirect here —
    // shadowing them sent the header's Reviews shield to the legacy preview.
    // The rest keep their pre-split bookmark compatibility.
    const paths: Record<string, string> = {
      briefing: "/apps/command-center/briefing", inbox: "/apps/command-center/inbox",
      work: "/apps/neuralflow/tasks", focus: "/apps/neuralflow/focus",
      // /alfred keeps its workspace page: the run UI (start a run, recent
      // runs) is server-rendered there. The lens chat screen stays at
      // /apps/alfred/chat for lens navigation.
      // Knowledge and Dossiers have real Neon-backed workspace screens, so their
      // legacy bare paths go there, not to the sample lens preview.
      knowledge: "/alfred/knowledge", dossiers: "/alfred/dossiers",
      relationships: "/apps/command-center/contacts", opportunities: "/apps/command-center/opportunities",
    };
    return Object.entries(paths).map(([source, destination]) => ({ source: `/${source}`, destination, permanent: false }));
  },
  cacheComponents: true,
  partialPrefetching: true,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

// Verified API shape: withEve(config, { agents: { <name>: { root } } }).
// alfred is the first-party chief-of-staff agent; specialist serves every
// hired specialist profile (the run's role brief arrives as client context).
export default withEve(nextConfig, {
  agents: { alfred: "./eve/alfred", specialist: "./eve/specialist" },
});
