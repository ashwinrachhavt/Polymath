"use client";

import { Select } from "@/components/ui/select";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { editStudioDraftAction, linkDraftToRecordAction, unlinkDraftFromRecordAction } from "./actions";

type LinkRow = { id: string; targetType: string; targetId: string; label: string | null };
type Pick = { id: string; title: string };

/*
 * The reviewed-output workbench for one Studio draft: read it with the pinned
 * sources it stands on, edit the text into a new version, and attach it to
 * the task, contact, or opportunity it informs. Editing never republishes:
 * the draft's status only changes through Keep/Discard.
 */
export function DraftWorkbench({
  suggestedNextStep,
  artifact,
  versions,
  text,
  sources,
  links,
  linkTitles,
  linkable,
}: {
  suggestedNextStep?: string | null;
  artifact: { id: string; title: string; status: string; version: number };
  /** Append-only version history, newest first. */
  versions: { versionNumber: number; reason: string; note: string | null; createdAt: Date }[];
  text: string;
  sources: { documentId: string; title: string; pinnedHash: string | null }[];
  links: LinkRow[];
  linkTitles: Record<string, string>;
  linkable: { task: Pick[]; contact: Pick[]; opportunity: Pick[] };
}) {
  const router = useRouter();
  const [draftText, setDraftText] = useState(text);
  const [version, setVersion] = useState(artifact.version);
  const [targetType, setTargetType] = useState<"task" | "contact" | "opportunity">("task");
  const [targetId, setTargetId] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [linkCopied, setLinkCopied] = useState(false);

  const dirty = draftText !== text;
  const stablePath = `/alfred/dossiers?draft=${artifact.id}`;

  async function copyStableLink() {
    try {
      await navigator.clipboard.writeText(`${window.location.origin}${stablePath}`);
      setLinkCopied(true);
      setTimeout(() => setLinkCopied(false), 2000);
    } catch {
      setError("Copying the link failed — copy it from the address bar instead.");
    }
  }
  const picks = linkable[targetType];

  async function saveEdits() {
    setPending(true);
    setError(null);
    setNotice(null);
    try {
      const result = await editStudioDraftAction({
        artifactId: artifact.id,
        expectedVersion: version,
        text: draftText,
        idempotencyKey: crypto.randomUUID(),
      });
      setVersion(result.version);
      setNotice("Edits saved as a new version.");
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Saving failed.");
    } finally {
      setPending(false);
    }
  }

  async function attach() {
    if (!targetId) return;
    setPending(true);
    setError(null);
    setNotice(null);
    try {
      await linkDraftToRecordAction({ artifactId: artifact.id, targetType, targetId, idempotencyKey: crypto.randomUUID() });
      setTargetId("");
      setNotice("Attached.");
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Attaching failed.");
    } finally {
      setPending(false);
    }
  }

  async function detach(linkId: string) {
    setPending(true);
    setError(null);
    setNotice(null);
    try {
      await unlinkDraftFromRecordAction({ artifactId: artifact.id, linkId, idempotencyKey: crypto.randomUUID() });
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Detaching failed.");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-baseline gap-2">
        <p className="font-medium text-[13px]">{artifact.title}</p>
        <Badge variant="secondary" className="font-normal">
          {artifact.status}
        </Badge>
        <span className="text-muted-foreground text-xs">version {artifact.version}</span>
      </div>
      <p className="text-muted-foreground text-xs">
        {artifact.status === "draft"
          ? "A draft is visible only here; keeping or discarding it is always your call."
          : "Kept as reviewed. Edits append a new version — earlier versions below are never overwritten."}
      </p>
      <div className="flex items-center gap-2 text-xs">
        <span className="text-muted-foreground">Stable link:</span>
        <code className="rounded bg-muted px-1.5 py-0.5">{stablePath}</code>
        <button type="button" className="text-muted-foreground underline underline-offset-2 hover:text-foreground" onClick={copyStableLink}>
          {linkCopied ? "Copied" : "Copy"}
        </button>
      </div>
      {suggestedNextStep ? (
        <p className="text-muted-foreground text-[13px]">Suggested next step: {suggestedNextStep}</p>
      ) : null}

      <textarea
        value={draftText}
        onChange={(event) => setDraftText(event.target.value)}
        rows={14}
        className="w-full rounded-md border border-input bg-transparent px-3 py-2 font-mono text-[13px] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      />
      <div className="flex items-center gap-3">
        <Button size="sm" variant="outline" disabled={pending || !dirty} onClick={saveEdits}>
          Save edits
        </Button>
        {notice ? <p className="text-muted-foreground text-xs">{notice}</p> : null}
        {error ? (
          <p role="alert" className="text-destructive text-xs">
            {error}
          </p>
        ) : null}
      </div>

      <div className="flex flex-col gap-1">
        <p className="font-medium text-muted-foreground text-xs uppercase tracking-wide">Version history</p>
        <ul className="flex flex-col gap-1">
          {versions.map((row) => (
            <li key={row.versionNumber} className="flex items-baseline gap-2 text-[13px]">
              <span className="font-mono text-xs">v{row.versionNumber}</span>
              <Badge variant="outline" className="font-normal">
                {row.reason}
              </Badge>
              {row.versionNumber === artifact.version ? (
                <span className="text-muted-foreground text-xs">current</span>
              ) : null}
              <span className="text-muted-foreground text-xs">
                {new Date(row.createdAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}
              </span>
              {row.note ? <span className="text-muted-foreground text-xs">— {row.note}</span> : null}
            </li>
          ))}
        </ul>
      </div>

      <div className="flex flex-col gap-1">
        <p className="font-medium text-muted-foreground text-xs uppercase tracking-wide">Supporting documents</p>
        {sources.length === 0 ? (
          <p className="text-muted-foreground text-[13px]">No pinned documents on this draft.</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {sources.map((source) => (
              <li key={source.documentId} className="flex items-baseline gap-2 text-[13px]">
                <a href={`/alfred/knowledge?doc=${source.documentId}`} className="underline underline-offset-2 hover:text-foreground">
                  {source.title}
                </a>
                {source.pinnedHash ? <span className="font-mono text-muted-foreground text-xs">pinned {source.pinnedHash.slice(0, 8)}</span> : null}
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="flex flex-col gap-2">
        <p className="font-medium text-muted-foreground text-xs uppercase tracking-wide">Attached records</p>
        {links.length === 0 ? (
          <p className="text-muted-foreground text-[13px]">Not attached to any task, contact, or opportunity yet.</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {links.map((link) => (
              <li key={link.id} className="flex items-baseline gap-2 text-[13px]">
                <Badge variant="outline" className="font-normal">
                  {link.targetType}
                </Badge>
                <span>{linkTitles[link.id] ?? "Untitled"}</span>
                <button type="button" className="text-muted-foreground text-xs underline underline-offset-2 hover:text-foreground" disabled={pending} onClick={() => detach(link.id)}>
                  Detach
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="flex items-center gap-2">
          <Select value={targetType} onChange={(event) => {
              setTargetType(event.target.value as "task" | "contact" | "opportunity");
              setTargetId("");
            }}
            className="rounded-md border border-input bg-transparent px-2 py-1.5 text-[13px]"
          >
            <option value="task">Task</option>
            <option value="contact">Contact</option>
            <option value="opportunity">Opportunity</option>
          </Select>
          <Select value={targetId} onChange={(event) => setTargetId(event.target.value)} className="min-w-0 flex-1 rounded-md border border-input bg-transparent px-2 py-1.5 text-[13px]">
            <option value="">Pick a record…</option>
            {picks.map((pick) => (
              <option key={pick.id} value={pick.id}>
                {pick.title}
              </option>
            ))}
          </Select>
          <Button size="sm" variant="outline" disabled={pending || !targetId} onClick={attach}>
            Attach
          </Button>
        </div>
      </div>
    </div>
  );
}
