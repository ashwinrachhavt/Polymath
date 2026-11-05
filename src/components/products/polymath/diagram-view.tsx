"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { useCallback, useState } from "react";
import { Check, Copy, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { supportsElementEdit } from "@/domains/diagrams/types";
import { pickDiagramVersion, type DiagramVersionView } from "@/domains/diagrams/view";
import type { DiagramPreviewOutcome } from "./diagram-preview";

/*
 * DiagramView — the read surface for a `diagram` artifact at
 * /artifacts/[artifactId] (spec art_Yi8Fwsqn §6). Mermaid is the stored
 * source of truth; nothing renders a stale or invented scene. The heavy
 * renderer mounts behind next/dynamic with ssr: false (locked decision 7) so
 * the artifact route's initial bundle carries no mermaid/excalidraw bytes.
 *
 * Editability honesty (locked decision 5): "Open in canvas" appears only for
 * a version that actually converted to an editable Excalidraw scene; every
 * image-fallback type says plainly that it opens as an image, not editable.
 */

const DiagramPreview = dynamic(() => import("./diagram-preview"), {
  ssr: false,
  loading: () => (
    <div role="status" className="panel flex min-h-64 items-center justify-center rounded-xl p-6">
      <p className="text-body-dense text-muted-foreground">Loading diagram renderer…</p>
    </div>
  ),
});

/** The existing canvas surface — the canvas route, not a new one. */
const CANVAS_HREF = "/apps/polymath/canvas";

export function DiagramView({ title, versions }: { title: string; versions: DiagramVersionView[] }) {
  const [selected, setSelected] = useState<number | undefined>(undefined);
  const [copied, setCopied] = useState(false);
  /** Editability of the version the preview last rendered — versioned so a
   * switch cannot flash the previous version's affordance. */
  const [previewEditability, setPreviewEditability] = useState<{ versionNumber: number; editable: boolean } | null>(
    null,
  );

  // Pure selection, not a hook — safe above the early return.
  const active = pickDiagramVersion(versions, selected);

  // Stable across renders (the version rides the outcome, not the closure),
  // so the preview island can list onOutcome in its effect deps.
  const handleOutcome = useCallback((outcome: DiagramPreviewOutcome) => {
    setPreviewEditability({
      versionNumber: outcome.versionNumber,
      editable: outcome.state === "rendered" && outcome.renderMode === "excalidraw",
    });
  }, []);

  if (!active) {
    return (
      <article className="panel rounded-xl p-6">
        <h1 className="mb-2 text-2xl font-medium">{title}</h1>
        <p className="text-body-dense text-muted-foreground">This diagram has no readable versions yet.</p>
      </article>
    );
  }

  const declaredEditable = supportsElementEdit(active.diagramType);
  const sceneEditable = previewEditability?.versionNumber === active.versionNumber && previewEditability.editable;

  function copySource() {
    void navigator.clipboard.writeText(active?.mermaid ?? "").then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    });
  }

  return (
    <article className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-medium">{title}</h1>
          <span className="readout rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground">
            v{active.versionNumber}
          </span>
        </div>
        {versions.length > 1 && (
          <span className="flex items-center gap-2 text-xs text-muted-foreground">
            <label htmlFor="diagram-version">Version</label>
            {/* w-28 rides the wrapper — the select fills it, the chevron stays inside. */}
            <span className="w-28">
              <Select
                id="diagram-version"
                variant="ghost"
                value={String(active.versionNumber)}
                onChange={(event) => setSelected(Number(event.target.value))}
                aria-label="Diagram version"
              >
                {versions.map((version) => (
                  <option key={version.versionNumber} value={version.versionNumber}>
                    v{version.versionNumber} · {version.reason}
                  </option>
                ))}
              </Select>
            </span>
          </span>
        )}
      </div>

      {!declaredEditable && (
        <p className="wrap-anywhere rounded-lg border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
          {active.diagramType} diagrams open as an image, not an editable scene.
        </p>
      )}

      <Tabs defaultValue="preview">
        <TabsList>
          <TabsTrigger value="preview">Preview</TabsTrigger>
          <TabsTrigger value="mermaid">Mermaid</TabsTrigger>
        </TabsList>
        <TabsContent value="preview" className="mt-4">
          {/* Keyed by version: a switch remounts the island, so the heavy
              renderer starts clean on the new source (its effect never
              resets state synchronously). */}
          <DiagramPreview
            key={`${active.versionNumber}-${active.diagramType}-${active.mermaid.length}`}
            mermaid={active.mermaid}
            diagramType={active.diagramType}
            versionNumber={active.versionNumber}
            onOutcome={handleOutcome}
          />
        </TabsContent>
        <TabsContent value="mermaid" className="mt-4">
          <div className="panel space-y-3 rounded-xl p-4">
            <div className="flex items-center justify-between">
              <p className="text-xs text-muted-foreground">
                Mermaid source for v{active.versionNumber}: the diagram regenerates from this text.
              </p>
              <Button variant="outline" size="sm" onClick={copySource}>
                {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
                {copied ? "Copied" : "Copy source"}
              </Button>
            </div>
            <pre className="max-h-96 overflow-auto rounded-lg bg-muted/40 p-3 text-xs leading-relaxed">
              <code className="wrap-anywhere">{active.mermaid}</code>
            </pre>
          </div>
        </TabsContent>
      </Tabs>

      {sceneEditable && (
        <p className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
          <Link
            href={CANVAS_HREF}
            className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-body-dense text-foreground hover:bg-muted"
          >
            <ExternalLink aria-hidden className="size-3.5" /> Open in canvas
          </Link>
          <span>This version converted to an editable Excalidraw scene.</span>
        </p>
      )}
    </article>
  );
}
