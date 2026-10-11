"use client";

import { useRef, useState } from "react";
import { useTheme } from "next-themes";
import { Excalidraw, MainMenu, WelcomeScreen, serializeAsJSON, loadFromBlob, exportToSvg, convertToExcalidrawElements, CaptureUpdateAction } from "@excalidraw/excalidraw";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import "@excalidraw/excalidraw/index.css";
import { Save, Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field, Status } from "@/components/workspace/ui";
import { useWorkspace } from "@/components/workspace/workspace-provider";
import type { Artifact } from "@/components/workspace/types";

export default function CanvasEditor({ record }: { record: Artifact }) {
  const { updateArtifact, notify } = useWorkspace();
  const { resolvedTheme } = useTheme();
  const api = useRef<ExcalidrawImperativeAPI | null>(null);
  const [title, setTitle] = useState(record.title);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState("");
  const [fullscreen, setFullscreen] = useState(false);
  function scene() { const current = api.current; return current ? serializeAsJSON(current.getSceneElements(), current.getAppState(), current.getFiles(), "database") : ""; }
  function download(content: string, extension: string, type: string) { const url = URL.createObjectURL(new Blob([content], { type })); const a = document.createElement("a"); a.href = url; a.download = `${title || "canvas"}.${extension}`; a.click(); URL.revokeObjectURL(url); }
  function insertTemplate(template: string) {
    const current = api.current;
    if (!current) return;
    const elements = template === "architecture" ? convertToExcalidrawElements([
      { type: "rectangle", x: 100, y: 120, width: 140, height: 80, label: { text: "Browser" } },
      { type: "rectangle", x: 340, y: 120, width: 180, height: 80, label: { text: "Axiom domain" } },
      { type: "rectangle", x: 620, y: 120, width: 160, height: 80, label: { text: "Canonical store" } },
      { type: "arrow", x: 240, y: 160, points: [[0, 0], [100, 0]] },
      { type: "arrow", x: 520, y: 160, points: [[0, 0], [100, 0]] },
    ]) : convertToExcalidrawElements([
      { type: "rectangle", x: 100, y: 120, width: 170, height: 80, label: { text: "Evidence" } },
      { type: "rectangle", x: 360, y: 120, width: 170, height: 80, label: { text: "Atomic idea" } },
      { type: "rectangle", x: 620, y: 120, width: 170, height: 80, label: { text: "Open question" } },
      { type: "arrow", x: 270, y: 160, points: [[0, 0], [90, 0]] },
      { type: "arrow", x: 530, y: 160, points: [[0, 0], [90, 0]] },
    ]);
    current.updateScene({ elements: [...current.getSceneElements(), ...elements], captureUpdate: CaptureUpdateAction.IMMEDIATELY });
    current.scrollToContent(elements, { fitToContent: true });
    setDirty(true);
  }
  return <div className="space-y-4"><Field label="Canvas title"><Input value={title} onChange={(e) => { setTitle(e.target.value); setDirty(true); }} /></Field><div className="flex flex-wrap items-center gap-2"><Status>{dirty ? "Unsaved canvas changes" : `Canonical canvas v${record.version}`}</Status><Button variant="outline" onClick={() => insertTemplate("architecture")}>Add system-design template</Button><Button variant="outline" onClick={() => insertTemplate("knowledge")}>Add evidence map</Button><Button variant="ghost" onClick={() => setFullscreen(!fullscreen)}>{fullscreen ? "Exit expanded view" : "Expand canvas"}</Button></div>{error && <div role="alert" className="space-y-2 text-[13px] text-destructive"><p>{error}</p><Button variant="outline" onClick={() => { setError(""); setDirty(true); }}>Use blank working canvas (save to replace)</Button></div>}<div className={fullscreen ? "panel relative flex h-[85dvh] min-h-96 flex-col overflow-hidden rounded-xl bg-background" : "panel relative h-[600px] min-h-96 overflow-hidden rounded-xl"}>{fullscreen && <div className="flex items-center justify-between gap-3 border-b border-border bg-card p-2 text-[13px]"><span>{title} / browser-only drawing</span><Button variant="outline" onClick={() => setFullscreen(false)}>Exit expanded view</Button></div>}<div className="h-full min-h-0"><Excalidraw excalidrawAPI={(instance) => { api.current = instance; }} theme={resolvedTheme === "dark" ? "dark" : "light"} name={title} initialData={async () => { if (!record.body.trim()) return null; try { return await loadFromBlob(new Blob([record.body], { type: "application/json" }), null, null); } catch { setError("Saved canvas data could not be read. Export the existing artifact from version history before replacing it, or start a blank working canvas explicitly."); return null; } }} onChange={() => { if (api.current && !error) setDirty(scene() !== record.body || title !== record.title); }} isCollaborating={false} aiEnabled={false} validateEmbeddable={false} handleKeyboardGlobally={false} UIOptions={{ canvasActions: { export: false, loadScene: false, saveToActiveFile: false, saveAsImage: false }, tools: { image: false } }} onLinkOpen={(_element, event) => { event.preventDefault(); notify("Canvas element links do not open external sites in this preview. Use linked canonical records below."); }}><MainMenu><MainMenu.DefaultItems.ClearCanvas /><MainMenu.DefaultItems.ToggleTheme /></MainMenu><WelcomeScreen><WelcomeScreen.Center><WelcomeScreen.Center.Heading>Draw, connect, then save a checkpoint.</WelcomeScreen.Center.Heading></WelcomeScreen.Center></WelcomeScreen></Excalidraw></div></div><div className="flex flex-wrap gap-2"><Button disabled={!!error || !title.trim()} onClick={() => { const body = scene(); if (!body) return; if (body.length > 2_000_000) { notify("Canvas exceeds the 2 MB browser preview limit. Export it locally instead of saving."); return; } updateArtifact(record.id, { title: title.trim(), body }); setDirty(false); notify("Canvas JSON saved with a canonical local checkpoint. No external sharing occurred."); }}><Save aria-hidden />Save canvas checkpoint</Button><Button variant="outline" onClick={() => download(scene(), "excalidraw", "application/json")}><Download aria-hidden />Export scene</Button><Button variant="outline" onClick={async () => { const current = api.current; if (!current) return; try { const svg = await exportToSvg({ elements: current.getSceneElements(), appState: current.getAppState(), files: current.getFiles() }); download(svg.outerHTML, "svg", "image/svg+xml"); } catch { notify("Canvas SVG could not be exported. Try exporting the scene JSON instead."); } }}>Export SVG</Button></div><p className="text-xs leading-relaxed text-muted-foreground">Real Excalidraw drawing, shapes, text, arrows and undo. Save before changing canvases; no autosave. AI, collaboration, embedded web content and image upload are disabled. Package fonts may load from the Excalidraw CDN; canvas content is not sent there.</p></div>;
}
