"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useTheme } from "next-themes";
import { ArrowLeft, Save } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Field, Status } from "@/components/workspace/ui";
import { parseCanvasScene, type CanvasSceneEnvelope, type ExcalidrawScenePayload } from "@/domains/diagrams/types";
import { renderDiagram } from "@/domains/diagrams/render";
import type { CanvasSceneVersionView } from "@/domains/diagrams/canvas-queries";
import { saveCanvasScene } from "@/app/(workspace)/polymath/canvas/[canvasId]/actions";

/*
 * The canonical canvas editor: the half of the diagram handshake that was
 * missing. Generated scenes persist in Postgres (canvases + canvas_versions,
 * append-only); this editor loads that chain and saves back onto it. A
 * Mermaid-envelope version converts in the browser (locked decision 4); a
 * saved Excalidraw version loads directly. Non-editable diagram types keep
 * the editor disabled and show their SVG preview (editability honesty,
 * locked decision 5) — the image-fallback path is a read surface, not a
 * broken editor.
 *
 * The heavy Excalidraw mount rides next/dynamic ssr:false, the house pattern
 * (canvas.tsx, diagram-view.tsx), so the route's initial bundle carries none
 * of it.
 */

const ExcalidrawCanvas = dynamic(() => import("./canonical-canvas-excalidraw"), {
  ssr: false,
  loading: () => (
    <p role="status" className="p-5 text-body-dense text-muted-foreground">
      Loading Excalidraw drawing tools…
    </p>
  ),
});

/** What resolving one version's scene comes to. */
type Resolution =
  | { state: "resolving" }
  | { state: "editable"; initial: ExcalidrawScenePayload; convertSkeletons: boolean }
  | { state: "image"; svg: string; reason: string }
  | { state: "failed"; message: string };

export default function CanonicalCanvasEditor({
  canvasId,
  title: initialTitle,
  artifactId,
  versions: initialVersions,
}: {
  canvasId: string;
  title: string;
  artifactId: string;
  versions: CanvasSceneVersionView[];
}) {
  const { resolvedTheme } = useTheme();
  const [versions, setVersions] = useState(initialVersions);
  const [selected, setSelected] = useState<number | undefined>(undefined);
  const [title, setTitle] = useState(initialTitle);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [notice, setNotice] = useState("");
  const sceneApiRef = useRef<{ scene: () => ExcalidrawScenePayload } | null>(null);

  const active = versions.find((v) => v.versionNumber === selected) ?? versions[versions.length - 1];
  // Sync-resolvable cases derive during render; only a mermaid-envelope
  // version needs the async conversion, and that effect sets state from its
  // promise callbacks alone (react-hooks/set-state-in-effect).
  const parsed: CanvasSceneEnvelope | null = active ? parseCanvasScene(active.scene) : null;
  const syncResolution: Resolution | null = !active
    ? { state: "failed", message: "This canvas has no versions yet." }
    : !parsed
      ? {
          state: "failed",
          message:
            "This version's scene could not be read. The generated source is still on the artifact's version chain.",
        }
      : parsed.format === "excalidraw"
        ? { state: "editable", initial: parsed.scene, convertSkeletons: false }
        : null;
  const [rendered, setRendered] = useState<{ version: number; resolution: Resolution } | null>(null);

  useEffect(() => {
    if (syncResolution !== null || !parsed || parsed.format !== "mermaid" || !active) return;
    // The version list is keyed by the select; a switch re-resolves through
    // the same effect. The live flag drops out-of-order mermaid renders.
    let live = true;
    const version = active.versionNumber;
    const theme = resolvedTheme === "dark" ? ("dark" as const) : ("default" as const);
    renderDiagram(parsed.mermaid, parsed.diagramType, { theme })
      .then((result) => {
        if (!live) return;
        if (result.renderMode === "excalidraw") {
          // The converter's elements are Excalidraw *skeletons*; the island
          // runs convertToExcalidrawElements over them before mounting.
          setRendered({
            version,
            resolution: {
              state: "editable",
              initial: {
                elements: result.elements as unknown[],
                ...(result.files ? { files: result.files as Record<string, unknown> } : {}),
              },
              convertSkeletons: true,
            },
          });
        } else {
          setRendered({ version, resolution: { state: "image", svg: result.svg, reason: result.fallbackReason } });
        }
      })
      .catch((error: unknown) => {
        if (!live) return;
        const message =
          error instanceof Error && error.name === "DiagramParseError"
            ? ((error as { parserMessage?: string }).parserMessage ?? error.message)
            : error instanceof Error
              ? error.message
              : String(error);
        setRendered({ version, resolution: { state: "failed", message } });
      });
    return () => {
      live = false;
    };
    // versions identity changes on save; the select's value drives re-resolution.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active?.versionNumber, resolvedTheme]);

  const resolution: Resolution =
    syncResolution ??
    (rendered && rendered.version === active?.versionNumber ? rendered.resolution : { state: "resolving" });

  async function save() {
    const current = sceneApiRef.current;
    if (!current || !active) return;
    setSaving(true);
    setSaveError("");
    const result = await saveCanvasScene({
      canvasId,
      title: title.trim() || undefined,
      scene: current.scene(),
    });
    setSaving(false);
    if (!result.ok) {
      setSaveError(result.message);
      return;
    }
    const appended: CanvasSceneVersionView = {
      versionNumber: result.versionNumber,
      scene: { format: "excalidraw", scene: current.scene() },
      createdAt: new Date().toISOString(),
    };
    setVersions((chain) => [...chain, appended]);
    setSelected(result.versionNumber);
    setDirty(false);
    setNotice(`Checkpoint saved as version ${result.versionNumber}.`);
  }

  return (
    <div className="space-y-4">
      <p className="text-body-dense">
        <Link
          href={`/artifacts/${artifactId}`}
          className="flex w-fit items-center gap-1 text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft aria-hidden className="size-3.5" /> Back to the diagram
        </Link>
      </p>
      <div className="flex flex-wrap items-end gap-4">
        <Field label="Canvas title">
          <Input
            value={title}
            onChange={(e) => {
              setTitle(e.target.value);
              setDirty(true);
            }}
          />
        </Field>
        {versions.length > 1 && (
          <span className="flex items-center gap-2 text-xs text-muted-foreground">
            <label htmlFor="canvas-version">Version</label>
            <span className="w-28">
              <Select
                id="canvas-version"
                variant="ghost"
                value={String(active?.versionNumber ?? "")}
                onChange={(event) => {
                  setSelected(Number(event.target.value));
                  setDirty(false);
                  setSaveError("");
                }}
                aria-label="Canvas version"
              >
                {versions.map((version) => (
                  <option key={version.versionNumber} value={version.versionNumber}>
                    v{version.versionNumber}
                  </option>
                ))}
              </Select>
            </span>
          </span>
        )}
      </div>

      <Status>
        {resolution.state === "editable"
          ? dirty
            ? "Unsaved canvas changes"
            : `Canonical canvas v${active?.versionNumber}`
          : resolution.state === "image"
            ? "Read-only image preview"
            : "Loading version…"}
      </Status>

      {resolution.state === "resolving" && (
        <p role="status" className="p-5 text-body-dense text-muted-foreground">
          Preparing the scene…
        </p>
      )}

      {resolution.state === "failed" && (
        <div role="alert" className="panel space-y-2 rounded-xl p-6">
          <p className="text-body-dense font-medium">This version did not open.</p>
          <p className="wrap-anywhere text-xs leading-relaxed text-muted-foreground">{resolution.message}</p>
          <p className="text-xs text-muted-foreground">
            The artifact still carries the full version chain and the Mermaid source.
          </p>
        </div>
      )}

      {resolution.state === "image" && (
        <div className="space-y-2">
          <p className="wrap-anywhere rounded-lg border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
            {resolution.reason} The Excalidraw editor stays disabled for this version.
          </p>
          {/* The SVG is mermaid's own output under its strict security level —
              stored LLM-authored source is never inserted as markup. */}
          <div className="panel flex min-h-64 items-center justify-center overflow-auto rounded-xl p-6">
            <div className="max-w-full [&>svg]:max-w-full" dangerouslySetInnerHTML={{ __html: resolution.svg }} />
          </div>
        </div>
      )}

      {resolution.state === "editable" && active && (
        <div className="space-y-3">
          {/* Keyed per version + resolution: a version switch remounts the
              editor instead of re-seeding a live scene. */}
          <ExcalidrawCanvas
            key={`${active.versionNumber}-${resolution.state}`}
            initial={resolution.initial}
            convertSkeletons={resolution.convertSkeletons}
            theme={resolvedTheme === "dark" ? "dark" : "light"}
            name={title}
            onSceneChange={() => setDirty(true)}
            sceneApiRef={sceneApiRef}
          />
          <div className="flex flex-wrap items-center gap-2">
            <Button disabled={saving || !dirty} onClick={() => void save()}>
              <Save aria-hidden />
              {saving ? "Saving…" : "Save canvas checkpoint"}
            </Button>
            {saveError && (
              <p role="alert" className="text-body-dense text-destructive">
                {saveError}
              </p>
            )}
            {!saveError && notice && <p className="text-body-dense text-muted-foreground">{notice}</p>}
          </div>
          <p className="text-xs leading-relaxed text-muted-foreground">
            Saving appends a new version to this canvas&apos;s canonical chain; generated versions are never rewritten.
            No autosave.
          </p>
        </div>
      )}
    </div>
  );
}

/** The imperative seam the Excalidraw island exposes to the editor above. */
