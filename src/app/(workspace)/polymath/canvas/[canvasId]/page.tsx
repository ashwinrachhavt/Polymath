import Link from "next/link";
import { connection } from "next/server";
import { Suspense } from "react";
import { Empty, Screen } from "@/components/workspace/ui";
import { getAuthContext } from "@/lib/auth";
import { getCanvasSceneView } from "@/domains/diagrams/canvas-queries";
import CanonicalCanvasEditor from "@/components/products/polymath/canonical-canvas-editor";

export const metadata = { title: "Canvas · Polymath" };

/*
 * The canonical canvas route: loads a canvas and its version chain straight
 * from canvases / canvas_versions, so a diagram's "Open in canvas" lands on
 * the scene the tool persisted.
 *
 * The domain query owns tenancy; a foreign or unknown canvasId renders the
 * empty state, not an error (the same contract as the wiki artifact reader).
 */

async function CanvasSurface({ params }: { params: Promise<{ canvasId: string }> }) {
  const { canvasId } = await params;
  await connection();
  const auth = await getAuthContext();
  const view = await getCanvasSceneView(auth, canvasId);

  return (
    <Screen title={view ? view.title : "Canvas"}>
      {view ? (
        <CanonicalCanvasEditor
          canvasId={canvasId}
          title={view.title}
          artifactId={view.artifactId}
          versions={view.versions}
        />
      ) : (
        <div className="mx-auto w-full max-w-[var(--measure-prose)]">
          <Empty
            title="This canvas is not available."
            description="It may belong to another workspace or have been removed."
            action={
              <Link href="/artifacts" className="text-body-dense font-medium underline underline-offset-4">
                Back to Artifacts
              </Link>
            }
          />
        </div>
      )}
    </Screen>
  );
}

export default function CanvasPage({ params }: { params: Promise<{ canvasId: string }> }) {
  return (
    <Suspense
      fallback={
        <p role="status" className="p-6 text-body-dense text-muted-foreground">
          Loading canvas…
        </p>
      }
    >
      <CanvasSurface params={params} />
    </Suspense>
  );
}
