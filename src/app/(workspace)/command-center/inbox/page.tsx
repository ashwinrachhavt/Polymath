import { connection } from "next/server";
import Link from "next/link";
import { Suspense } from "react";
import { Button } from "@/components/ui/button";
import { Empty, Panel, Screen, Status } from "@/components/workspace/ui";
import { countToClarify, type InboxFilter, listCaptures } from "@/domains/capture/queries";
import { getAuthContext } from "@/lib/auth";
import { CaptureActions, CaptureForm } from "./inbox-client";

export const metadata = { title: "Inbox · Axiom" };

/*
 * The durable inbox (ASH-137 A02): captures live in Postgres, the original
 * material survives conversion, and clarify-before-commit means a capture
 * becomes a canonical task only by an explicit per-row decision. Nothing is
 * classified or converted by a model on this page.
 */

const filters: Array<{ value: InboxFilter; label: string }> = [
  { value: "unprocessed", label: "To clarify" },
  { value: "converted", label: "Converted" },
  { value: "discarded", label: "Archived" },
  { value: "all", label: "All captures" },
];

function when(iso: Date): string {
  return iso.toISOString().slice(0, 16).replace("T", " ") + "Z";
}

async function Inbox({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const query = await searchParams;
  const raw = typeof query.filter === "string" ? query.filter : "unprocessed";
  const filter: InboxFilter = filters.some((f) => f.value === raw) ? (raw as InboxFilter) : "unprocessed";
  await connection();
  const auth = await getAuthContext();
  const [rows, pending] = await Promise.all([listCaptures(auth, filter), countToClarify(auth)]);

  return (
    <Screen
      title="Inbox"
      description="Clarify before committing. Original text stays here after conversion; nothing is classified or fetched on arrival."
      actions={<Status>{pending} to clarify</Status>}
    >
      <Panel title="Capture material" description="Text or a URL. Remote content is not fetched; a duplicate URL is a conflict, not a second row.">
        <CaptureForm />
      </Panel>

      <nav aria-label="Inbox filters" className="flex flex-wrap gap-3 text-[13px]">
        {filters.map((f) => (
          <Link
            key={f.value}
            href={f.value === "unprocessed" ? "/command-center/inbox" : `/command-center/inbox?filter=${f.value}`}
            className={f.value === filter ? "font-medium underline underline-offset-4" : "text-muted-foreground hover:underline"}
          >
            {f.label}
          </Link>
        ))}
      </nav>

      <Panel title={`${rows.length} ${rows.length === 1 ? "capture" : "captures"}`}>
        <div className="divide-y divide-border">
          {rows.map((capture) => {
            const state =
              capture.processingState === "converted" ? "converted" : capture.processingState === "discarded" ? "discarded" : "open";
            return (
              <article key={capture.id} className="py-4 first:pt-0">
                <div className="mb-2 flex flex-wrap items-center gap-2">
                  <Status>{capture.processingState}</Status>
                  <span className="text-xs text-muted-foreground">{capture.kind}</span>
                  <time className="readout text-xs text-muted-foreground" dateTime={capture.createdAt.toISOString()}>
                    {when(capture.createdAt)}
                  </time>
                </div>
                <p className="whitespace-pre-wrap break-words text-[13px]">{capture.text ?? capture.url}</p>
                <CaptureActions captureId={capture.id} version={capture.version} state={state} />
                {capture.processingState === "converted" && capture.convertedType === "task" && capture.convertedId ? (
                  <Button asChild className="mt-3" size="sm" variant="outline">
                    <Link href={`/neuralflow/work?task=${encodeURIComponent(capture.convertedId)}`}>Open task in NeuralFlow</Link>
                  </Button>
                ) : null}
              </article>
            );
          })}
        </div>
        {!rows.length ? <Empty title="Nothing in this view" description="Capture material above or choose another filter." /> : null}
      </Panel>
    </Screen>
  );
}

export default function InboxPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  return (
    <Suspense fallback={<p role="status" className="p-6 text-[13px] text-muted-foreground">Opening the inbox…</p>}>
      <Inbox searchParams={searchParams} />
    </Suspense>
  );
}
