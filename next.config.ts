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
      knowledge: "/apps/alfred/library", dossiers: "/apps/alfred/dossiers",
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

// Spike (Task 1): mounts the throwaway eve agent at /eve/alfred/v1/*.
// Verified API shape: withEve(config, { agents: { <name>: { root } } }).
export default withEve(nextConfig, { agents: { alfred: "./eve/alfred" } });
