"use client";

import dynamic from "next/dynamic";
import type { ComponentType } from "react";
import PolymathStorageWarning from "./feature-storage-warning";

const loading = () => (
  <p role="status" className="p-6 text-body-dense text-muted-foreground">
    Loading Alfred workspace…
  </p>
);
const screens: Record<string, ComponentType<{ initialId?: string }>> = {
  dashboard: dynamic(() => import("./dashboard"), { loading }),
  library: dynamic(() => import("./library"), { loading }),
  // zettels has no entry: the /polymath/knowledge/zettels/** route redirects
  // to /polymath/ideas and the dead screen component is deleted; the map is
  // never consulted with screen="zettels" for the same reason as notebook.
  dossiers: dynamic(() => import("./dossiers"), { loading }),
  // notebook has no entry: /apps/polymath/notebook redirects to the canonical
  // /polymath/notes surface before this map is ever consulted.
  graph: dynamic(() => import("./graph"), { loading }),
  studio: dynamic(() => import("./studio"), { loading }),
  research: dynamic(() => import("./research"), { loading }),
  chat: dynamic(() => import("./chat"), { loading }),
  blogs: dynamic(() => import("./blogs"), { loading }),
  dictionary: dynamic(() => import("./dictionary"), { loading }),
  canvas: dynamic(() => import("./canvas"), { loading }),
  projects: dynamic(() => import("./projects"), { loading }),
  integrations: dynamic(() => import("./integrations"), { loading }),
};
export default function PolymathScreen({ screen, initialId }: { screen: string; initialId?: string }) {
  const Component = screens[screen];
  return Component ? (
    <>
      <PolymathStorageWarning />
      <Component initialId={initialId} />
    </>
  ) : null;
}
