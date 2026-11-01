import type { NextConfig } from "next";
import { withEve } from "eve/next";
import { nextConfigRedirects } from "./redirects";

const nextConfig: NextConfig = {
  experimental: {
    agentUpgrade: "security",
  },
  async redirects() {
    // The table lives in ./redirects.ts — outside src/ (the rename-sweep
    // audit walks src/) and executable in unit tests without calling this
    // withEve-wrapped config function (build-time side effects).
    return nextConfigRedirects();
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
