"use client";

import { useState, type ReactNode } from "react";
import { AlertCircle, Loader2, Plus, RotateCw } from "lucide-react";
import { Popover } from "radix-ui";
import { cn } from "cn";
import { SubjectJobProgress } from "@/components/jobs/job-progress";
import { IconButton } from "@/components/ui/icon-button";
import { Tooltip } from "@/components/ui/tooltip";
import type { SourceRow } from "@/domains/knowledge/source-readiness";
import { AddSources } from "./add-sources";

/*
 * The top of a notebook, as a Perplexity Space opens: what the space is (its
 * title and one-line description), the sources it answers from as a compact
 * tray of chips, and the few actions that belong to the space itself. The
 * conversation below is the centre of the page; this header only frames it.
 *
 * Sources are chips, not a column: five or fewer sit in the row, the rest in a
 * "more" list, and the add control (a link, a file, or a pick from the Vault)
 * opens from the plus. A source that is still being read shows a spinner and a
 * failed one a retry, so state is visible without opening anything.
 */

type VaultDoc = { id: string; title: string };

/** The readiness vocabulary the tray shows; one label per state of the existing field. */
const READINESS_LABEL: Record<SourceRow["readiness"], string> = {
  queued: "Reading...",
  extracting: "Reading...",
  embedding: "Reading...",
  ready: "Ready",
  failed: "Failed",
  unsupported: "Failed",
};

const VISIBLE_CHIPS = 5;

const isFailed = (source: SourceRow) => source.readiness === "failed" || source.readiness === "unsupported";
const isReading = (source: SourceRow) => !isFailed(source) && source.readiness !== "ready";

function SourceChip({
  source,
  retrying,
  onRetry,
}: {
  source: SourceRow;
  retrying: boolean;
  onRetry: (documentId: string) => void;
}) {
  const detail = source.kind === "video" ? "Video" : "Document";
  return (
    <li
      className={cn(
        "border-border bg-card flex h-7 max-w-[16rem] min-w-0 items-center gap-1.5 rounded-full border pr-1 pl-2.5 text-body-dense",
        isFailed(source) && "border-destructive/40",
      )}
    >
      <Tooltip content={`${source.title}. ${detail}, ${READINESS_LABEL[source.readiness].toLowerCase()}`}>
        <span className="min-w-0 truncate">{source.title}</span>
      </Tooltip>
      {isReading(source) ? (
        <Loader2 aria-label="Reading" role="img" className="text-muted-foreground size-3.5 shrink-0 animate-spin" />
      ) : null}
      {isFailed(source) ? (
        <>
          <AlertCircle aria-label="Failed" role="img" className="text-destructive size-3.5 shrink-0" />
          <IconButton
            label={`Retry ${source.title}`}
            icon={retrying ? <Loader2 aria-hidden className="animate-spin" /> : <RotateCw aria-hidden />}
            size="icon-xs"
            disabled={retrying}
            onClick={() => onRetry(source.documentId)}
          />
        </>
      ) : (
        <span className="w-1" aria-hidden />
      )}
    </li>
  );
}

export function SpaceHeader({
  projectId,
  title,
  description,
  sources,
  vault,
  retrying,
  retryNote,
  onRetry,
  actions,
}: {
  projectId: string;
  title: string;
  description: string | null;
  sources: SourceRow[];
  vault: VaultDoc[];
  retrying: string | null;
  retryNote: string | null;
  onRetry: (documentId: string) => void;
  /** The space's own actions: icon buttons and the overflow menu. */
  actions: ReactNode;
}) {
  const [addOpen, setAddOpen] = useState(false);
  const shown = sources.slice(0, VISIBLE_CHIPS);
  const rest = sources.slice(VISIBLE_CHIPS);
  const readyCount = sources.filter((source) => source.readiness === "ready").length;
  const reading = sources.filter(isReading);

  return (
    <header className="flex flex-col gap-3">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <h1 className="screen-title">{title}</h1>
          {description ? <p className="text-muted-foreground line-clamp-2 text-body-dense">{description}</p> : null}
        </div>
        <div className="flex shrink-0 items-center gap-0.5">{actions}</div>
      </div>

      <div aria-label="Sources" role="group" className="flex flex-wrap items-center gap-1.5">
        <span className="text-muted-foreground mr-1 text-body-dense">
          {sources.length === 0 ? "No sources" : `${readyCount} of ${sources.length} ready`}
        </span>
        {sources.length > 0 ? (
          <ul className="flex min-w-0 flex-wrap items-center gap-1.5">
            {shown.map((source) => (
              <SourceChip
                key={source.documentId}
                source={source}
                retrying={retrying === source.documentId}
                onRetry={onRetry}
              />
            ))}
          </ul>
        ) : null}
        {rest.length > 0 ? (
          <Popover.Root>
            <Popover.Trigger className="text-muted-foreground hover:bg-muted hover:text-foreground h-7 rounded-full px-2 text-body-dense outline-none focus-visible:ring-3 focus-visible:ring-ring">
              +{rest.length} more
            </Popover.Trigger>
            <Popover.Portal>
              <Popover.Content
                align="start"
                sideOffset={6}
                className="panel bg-popover text-popover-foreground z-50 max-h-80 w-80 max-w-[90vw] overflow-y-auto rounded-xl p-2 outline-none"
              >
                <ul className="flex flex-col">
                  {rest.map((source) => (
                    <li
                      key={source.documentId}
                      className="flex items-center gap-2 rounded-md px-2 py-1.5 text-body-dense"
                    >
                      <span className="min-w-0 flex-1 truncate">{source.title}</span>
                      <span className="text-muted-foreground shrink-0 text-xs">
                        {READINESS_LABEL[source.readiness]}
                      </span>
                      {isFailed(source) ? (
                        <IconButton
                          label={`Retry ${source.title}`}
                          icon={<RotateCw aria-hidden />}
                          size="icon-xs"
                          disabled={retrying === source.documentId}
                          onClick={() => onRetry(source.documentId)}
                        />
                      ) : null}
                    </li>
                  ))}
                </ul>
              </Popover.Content>
            </Popover.Portal>
          </Popover.Root>
        ) : null}
        <Popover.Root open={addOpen} onOpenChange={setAddOpen}>
          <Popover.Trigger asChild>
            <IconButton label="Add a source" icon={<Plus aria-hidden />} size="icon-sm" variant="outline" />
          </Popover.Trigger>
          <Popover.Portal>
            <Popover.Content
              align="start"
              sideOffset={6}
              className="panel bg-popover text-popover-foreground z-50 w-80 max-w-[90vw] rounded-xl p-3 outline-none"
            >
              <AddSources projectId={projectId} vault={vault} />
            </Popover.Content>
          </Popover.Portal>
        </Popover.Root>
      </div>

      {reading.length > 0 ? (
        <div className="flex flex-col gap-1">
          {reading.map((source) => (
            <SubjectJobProgress key={source.documentId} subject={`document:${source.documentId}`} />
          ))}
        </div>
      ) : null}
      {retryNote ? (
        <p role="status" className="text-muted-foreground text-xs leading-relaxed">
          {retryNote}
        </p>
      ) : null}
    </header>
  );
}
