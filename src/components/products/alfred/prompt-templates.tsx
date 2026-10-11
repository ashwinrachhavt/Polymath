"use client";

import { useState } from "react";
import { Copy, Save } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Panel, Field, Empty, Status } from "@/components/workspace/ui";
import { useWorkspace } from "@/components/workspace/workspace-provider";
import { ArtifactList, ArtifactEditor, NewArtifact } from "./artifact-controls";

export default function PromptTemplates() {
  const { state, addArtifact, updateArtifact, notify } = useWorkspace();
  const [id, setId] = useState("");
  const [values, setValues] = useState<Record<string, string>>({});
  const templates = state.artifacts.filter((item) => item.tags.includes("Prompt template"));
  const selected = templates.find((item) => item.id === id) || (!id ? templates[0] : undefined);
  const variables = [...new Set([...(selected?.body || "").matchAll(/\{\{\s*([a-zA-Z][a-zA-Z0-9_]*)\s*\}\}/g)].map((match) => match[1]))];
  const rendered = (selected?.body || "").replace(/\{\{\s*([a-zA-Z][a-zA-Z0-9_]*)\s*\}\}/g, (match, name: string) => values[name] || match);
  const complete = variables.every((name) => values[name]?.trim());
  return <Panel title="Reusable prompt templates" description="Canonical template notes and local variable rendering. Rendering is not model or workflow execution." actions={<NewArtifact kind="note" label="New template" tags={["Prompt template"]} defaultBody="Explain {{topic}} for {{audience}}. Cite the supplied evidence and flag uncertainty." onCreated={(record) => { setId(record.id); setValues({}); }} />}><div className="grid gap-6 lg:grid-cols-[260px_minmax(0,1fr)]"><ArtifactList records={templates} selectedId={selected?.id} onSelect={(id) => { setId(id); setValues({}); }} empty="No templates yet" />{selected ? <Tabs defaultValue="use"><TabsList><TabsTrigger value="use">Use template</TabsTrigger><TabsTrigger value="edit">Edit template</TabsTrigger></TabsList><TabsContent value="use"><div className="space-y-4"><Status>Template v{selected.version}</Status>{variables.map((name) => <Field key={name} label={`Variable: ${name}`}><Input required value={values[name] || ""} onChange={(e) => setValues({ ...values, [name]: e.target.value })} /></Field>)}<Field label="Rendered prompt"><Textarea readOnly rows={6} value={rendered} /></Field>{!complete && <p className="text-xs text-muted-foreground">Fill every variable before saving or copying the rendered prompt.</p>}<div className="flex flex-wrap gap-2"><Button variant="outline" disabled={!complete} onClick={() => { const note = addArtifact(`Rendered prompt: ${selected.title}`, "note", `Template: ${selected.title} (${selected.id}) v${selected.version}\nStatus: Rendered locally, not executed\n\n${rendered}`); if (note) { updateArtifact(note.id, { tags: ["Rendered prompt"], links: [selected.id] }); notify("Rendered prompt saved as a canonical note. No model or workflow was invoked."); } }}><Save aria-hidden />Save rendered prompt</Button><Button variant="outline" disabled={!complete} onClick={async () => { try { await navigator.clipboard.writeText(rendered); notify("Rendered prompt copied."); } catch { notify("Clipboard access is unavailable. Select and copy the rendered prompt manually."); } }}><Copy aria-hidden />Copy</Button><Button disabled>Run (not connected)</Button></div></div></TabsContent><TabsContent value="edit"><ArtifactEditor key={selected.id} record={selected} /></TabsContent></Tabs> : <Empty title="Create a reusable template" description="Use {{variable_name}} placeholders, fill them locally and save the resolved prompt. Advanced workflow editing is not connected." />}</div></Panel>;
}
