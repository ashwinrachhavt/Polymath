import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  async redirects() {
    const paths: Record<string, string> = {
      briefing: "/apps/command-center/briefing", inbox: "/apps/command-center/inbox",
      work: "/apps/neuralflow/tasks", focus: "/apps/neuralflow/focus", alfred: "/apps/alfred/chat",
      knowledge: "/apps/alfred/library", dossiers: "/apps/alfred/dossiers",
      relationships: "/apps/command-center/contacts", opportunities: "/apps/command-center/opportunities",
      reviews: "/apps/command-center/reviews", activity: "/apps/command-center/activity", settings: "/apps/command-center/settings",
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

export default nextConfig;
