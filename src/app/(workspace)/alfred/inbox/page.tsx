import { Suspense } from "react";
import { connection } from "next/server";
import { Skeleton } from "@/components/ui/skeleton";
import { Empty, Panel, Screen } from "@/components/workspace/ui";
import { listCaptures } from "@/domains/capture/queries";
import { getDocumentInbox } from "@/domains/knowledge/queries";
import { documentStatus } from "@/domains/knowledge/status";
import { getAuthContext } from "@/lib/auth";
import { CaptureForm, CaptureRowActions, DocumentRowActions } from "./inbox-controls";

export const metadata = { title: "Inbox · Polymath" };

/*
 * The capture inbox (Capture and Notes spec, slice 1): everything captured,
 * before it is filed. Text and URL captures land in the shared capture store
 * (ASH-137) and wait here until they are accepted into the notebook as
 * notes, edited, or discarded; pages and files captured through the document
 * path (#124) show with their live read state. One store each, one list, one
 * action per row - no second inbox.
 */

const stamp = (d: Date) => d.toLocaleString("en", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

function captureText(raw: unknown, text: string | null, url: string | null): string {
  if (text) return text;
  if (url) return url;
  const payload = raw as { text?: string; url?: string; title?: string } | null;
  return payload?.text ?? payload?.url ?? payload?.title ?? "Captured item";
}

async function InboxBody() {
  await connection();
  const auth = await getAuthContext();
  const [captures, documents] = await Promise.all([listCaptures(auth, "unprocessed"), getDocumentInbox(auth, 25)]);
  return (
    <div className="space-y-4">
      <Panel title="Quick capture" description="Write it down now, decide later. Capturing never blocks: classification and enrichment happen after it lands.">
        <CaptureForm />
      </Panel>
      <Panel title="Captures" description={captures.length ? `${captures.length} waiting for a decision` : undefined}>
        {captures.length === 0 ? (
          <Empty title="Nothing captured" description="Capture a thought above and it waits here until you accept it into the notebook, edit it, or discard it." />
        ) : (
          <ul className="divide-y divide-border">
            {captures.map((item) => (
              <li key={item.id} className="flex flex-wrap items-center gap-3 py-3">
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] font-medium">{captureText(item.rawPayload, item.text, item.url).split("\n")[0]}</span>
                  <span className="mt-0.5 block text-[11px] uppercase tracking-wide text-muted-foreground/70">{item.kind} · {item.processingState} · {stamp(item.createdAt)}</span>
                </span>
                <CaptureRowActions id={item.id} version={item.version} />
              </li>
            ))}
          </ul>
        )}
      </Panel>
      <Panel title="Captured pages and files" description="URLs and files arrive through the document capture path and file themselves; their read state shows here.">
        {documents.length === 0 ? (
          <Empty title="No pages or files yet" description="Capture a URL or upload a file from the Knowledge tab and it shows up here while it is read." />
        ) : (
          <ul className="divide-y divide-border">
            {documents.map((doc) => {
              const status = documentStatus(doc.extractionStatus ? { status: doc.extractionStatus, proposalStatus: doc.proposalStatus, createdAt: doc.extractionCreatedAt } : null, doc.undecidedProposals);
              return (
                <li key={doc.id} className="flex flex-wrap items-center gap-3 py-3">
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] font-medium">{doc.title}</span>
                    <span className="mt-0.5 block truncate text-xs text-muted-foreground">{doc.sourceUrl ?? doc.filename ?? ""}</span>
                    <span className="mt-0.5 block text-[11px] text-muted-foreground/70">{doc.kind === "web_page" ? "Web page" : "File"} · {status.label} · {stamp(doc.createdAt)}</span>
                  </span>
                  <DocumentRowActions id={doc.id} version={doc.version} />
                </li>
              );
            })}
          </ul>
        )}
      </Panel>
    </div>
  );
}

export default function InboxPage() {
  return (
    <Screen title="Inbox" description="Everything you captured, before it is filed.">
      <Suspense fallback={<Skeleton className="h-64 w-full" />}>
        <InboxBody />
      </Suspense>
    </Screen>
  );
}
