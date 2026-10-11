"use client";

import dynamic from "next/dynamic";
import type { ComponentType } from "react";
import AlfredStorageWarning from "./feature-storage-warning";

const loading = () => <p role="status" className="p-6 text-[13px] text-muted-foreground">Loading Alfred workspace…</p>;
const screens: Record<string, ComponentType<{ initialId?: string }>> = {
  dashboard: dynamic(() => import("./dashboard"), { loading }),
  library: dynamic(() => import("./library"), { loading }),
  zettels: dynamic(() => import("./zettels"), { loading }),
  dossiers: dynamic(() => import("./dossiers"), { loading }),
  notebook: dynamic(() => import("./notebook"), { loading }),
  graph: dynamic(() => import("./graph"), { loading }),
  studio: dynamic(() => import("./studio"), { loading }),
  research: dynamic(() => import("./research"), { loading }),
  chat: dynamic(() => import("./chat"), { loading }),
  blogs: dynamic(() => import("./blogs"), { loading }),
  dictionary: dynamic(() => import("./dictionary"), { loading }),
  learning: dynamic(() => import("./learning"), { loading }),
  canvas: dynamic(() => import("./canvas"), { loading }),
  projects: dynamic(() => import("./projects"), { loading }),
  integrations: dynamic(() => import("./integrations"), { loading }),
};
export default function AlfredScreen({ screen, initialId }: { screen: string; initialId?: string }) {
  const Component = screens[screen];
  return Component ? <><AlfredStorageWarning /><Component initialId={initialId} /></> : null;
}
