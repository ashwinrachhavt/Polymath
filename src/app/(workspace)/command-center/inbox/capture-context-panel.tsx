import Link from "next/link";
import { readCaptureContext } from "@/domains/capture/context";
import { safeHref } from "@/components/markdown-inline";

/*
 * Everything the capture kept besides its words: why it matters (or that the
 * owner did not know yet), the exact passage inside the text around it, where
 * it came from, and where it might belong. Renders nothing for a capture that
 * arrived with no context, so older rows read exactly as before.
 */

const when = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[8rem_1fr] gap-3 text-body-dense">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0">{children}</dd>
    </div>
  );
}

export function CaptureContextPanel({ rawPayload }: { rawPayload: unknown }) {
  const context = readCaptureContext(rawPayload);
  if (!context) return null;
  const { why, passage, surrounding, source, turn, region, partial, suggestion, capturedAt } = context;
  const sourceHref = source?.url ? safeHref(source.url) : null;

  return (
    <section aria-label="Capture context" className="mt-6 flex max-w-[70ch] flex-col gap-5 border-t border-border pt-6">
      {partial ? (
        <p role="note" className="rounded-md border border-border bg-muted/40 px-3 py-2 text-body-dense">
          <span className="font-medium">Partial capture.</span> {partial.reason}
        </p>
      ) : null}

      <div>
        <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Why it matters</h3>
        {why?.kind === "answer" ? (
          <p className="mt-1.5 text-body-dense">
            {why.text}
            {why.via === "voice" ? <span className="ml-2 text-xs text-muted-foreground">dictated</span> : null}
          </p>
        ) : why?.kind === "unknown" ? (
          <p className="mt-1.5 text-body-dense text-muted-foreground">Not known yet.</p>
        ) : (
          <p className="mt-1.5 text-body-dense text-muted-foreground">No reason given.</p>
        )}
      </div>

      {passage ? (
        <div>
          <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Highlighted passage</h3>
          <p className="mt-1.5 text-body-dense leading-relaxed">
            {surrounding?.before ? <span className="text-muted-foreground">…{surrounding.before} </span> : null}
            <mark className="rounded-sm bg-primary/15 px-0.5 text-foreground">{passage}</mark>
            {surrounding?.after ? (
              <span className="text-muted-foreground">
                {" "}
                {surrounding.after}
                {/[.!?]$/.test(surrounding.after) ? "" : "…"}
              </span>
            ) : null}
          </p>
        </div>
      ) : null}

      <dl className="flex flex-col gap-1.5">
        {source?.title || sourceHref ? (
          <Row label="Source">
            {sourceHref ? (
              <a
                href={sourceHref}
                className="underline decoration-foreground/30 underline-offset-2 hover:decoration-foreground"
                {...(sourceHref.startsWith("http") ? { target: "_blank", rel: "noreferrer noopener" } : {})}
              >
                {source?.title ?? sourceHref}
              </a>
            ) : (
              source?.title
            )}
            {source?.author ? <span className="text-muted-foreground"> · {source.author}</span> : null}
          </Row>
        ) : null}
        {turn ? (
          <Row label="Conversation">
            {turn.role === "assistant" ? "An answer" : turn.role === "user" ? "Your message" : "A turn"}
          </Row>
        ) : null}
        {source?.version || source?.publishedAt ? (
          <Row label="Version">
            {[source.version, source.publishedAt ? `published ${when(source.publishedAt)}` : null]
              .filter(Boolean)
              .join(" · ")}
          </Row>
        ) : null}
        {region ? (
          <Row label="Region">
            {Math.round(region.width)}×{Math.round(region.height)} at {Math.round(region.x)}, {Math.round(region.y)}
          </Row>
        ) : null}
        {capturedAt ? (
          <Row label="Captured">
            <time dateTime={capturedAt} suppressHydrationWarning>
              {when(capturedAt)}
            </time>
          </Row>
        ) : null}
        {suggestion?.projectId ? (
          <Row label="Might belong">
            <Link
              href={`/projects/${suggestion.projectId}`}
              className="underline decoration-foreground/30 underline-offset-2 hover:decoration-foreground"
            >
              {suggestion.projectTitle ?? "A project"}
            </Link>
          </Row>
        ) : null}
        {suggestion?.question ? <Row label="Question">{suggestion.question}</Row> : null}
      </dl>
    </section>
  );
}
