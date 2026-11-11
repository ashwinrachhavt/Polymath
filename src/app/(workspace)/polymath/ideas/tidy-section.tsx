import Link from "next/link";
import type { TidyArtifactView, TidyFindingView } from "@/domains/knowledge/tidy";
import { DisagreementDecision, DismissFinding } from "./tidy-controls";

/*
 * What Tidy noticed, above the Ideas list, grouped by what a person does
 * about it. Absent when nothing is open. A disagreement opens in place with
 * both ideas side by side; everything else links to the note or idea and can
 * be marked fine. Nothing here deletes anything.
 */

const GROUPS: Array<{ label: string; kinds: TidyFindingView["kind"][] }> = [
  { label: "Disagreements", kinds: ["disagreement"] },
  { label: "Possible duplicates", kinds: ["duplicate"] },
  { label: "Out of date", kinds: ["source_changed"] },
  { label: "Loose ends", kinds: ["unlinked", "broken_link"] },
];

/** A short list a person can finish, not a queue to manage. */
const ROWS_PER_GROUP = 5;

type Hrefs = { open: (card: TidyArtifactView) => string };

function CardLink({ card, hrefs }: { card: TidyArtifactView; hrefs: Hrefs }) {
  return (
    <Link href={hrefs.open(card)} className="font-medium underline underline-offset-2">
      {card.title}
    </Link>
  );
}

function IdeaSide({ label, card, hrefs }: { label: string; card: TidyArtifactView; hrefs: Hrefs }) {
  return (
    <div className="flex min-w-0 flex-col gap-2 rounded-lg border border-border bg-background/50 p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-body-dense break-words">
        <CardLink card={card} hrefs={hrefs} />
      </p>
      {card.excerpt ? <p className="text-body-dense break-words">{card.excerpt}</p> : null}
      {card.sourceQuote ? (
        <blockquote className="border-l-2 border-border pl-3 text-xs leading-relaxed text-muted-foreground">
          {card.sourceQuote}
          {card.sourceTitle ? <span className="mt-1 block">From {card.sourceTitle}</span> : null}
        </blockquote>
      ) : null}
    </div>
  );
}

function Disagreement({
  finding,
  other,
  open,
  hrefs,
}: {
  finding: Extract<TidyFindingView, { kind: "disagreement" }>;
  other: TidyArtifactView;
  open: boolean;
  hrefs: Hrefs;
}) {
  return (
    <details id={`tidy-${finding.id}`} open={open} className="rounded-lg border border-border">
      <summary className="cursor-pointer px-3 py-2 text-body-dense focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        &ldquo;{finding.subject.title}&rdquo; and &ldquo;{other.title}&rdquo; disagree
      </summary>
      <div className="flex flex-col gap-3 px-3 pb-3">
        <p className="text-body-dense text-muted-foreground">{finding.detail.reason}</p>
        <div className="grid gap-3 sm:grid-cols-2">
          <IdeaSide label="First idea" card={finding.subject} hrefs={hrefs} />
          <IdeaSide label="Second idea" card={other} hrefs={hrefs} />
        </div>
        <DisagreementDecision findingId={finding.id} />
      </div>
    </details>
  );
}

function describe(finding: TidyFindingView, hrefs: Hrefs) {
  const subject = <CardLink card={finding.subject} hrefs={hrefs} />;
  switch (finding.kind) {
    case "duplicate":
      return (
        <>
          {subject} and {finding.other ? <CardLink card={finding.other} hrefs={hrefs} /> : "another idea"} may say the
          same thing.
        </>
      );
    case "source_changed":
      return finding.detail.cause === "archived" ? (
        <>{subject} comes from a document that was archived.</>
      ) : (
        <>{subject} comes from a document that has been read again since.</>
      );
    case "unlinked":
      return <>{subject} is not linked to any other note or idea.</>;
    case "broken_link":
      return (
        <>
          {subject} links to [[{finding.detail.linkTitle}]], which does not exist.
        </>
      );
    case "disagreement":
      return null;
  }
}

export function TidySection({
  findings,
  total,
  openFindingId,
  hrefs,
}: {
  findings: TidyFindingView[];
  total: number;
  openFindingId: string | undefined;
  hrefs: Hrefs;
}) {
  if (findings.length === 0) return null;
  return (
    <section aria-labelledby="tidy-heading" className="mb-4 flex flex-col gap-3 rounded-lg border border-border p-3">
      <div>
        <h2 id="tidy-heading" className="text-body-dense font-medium">
          Tidy
        </h2>
        <p className="text-xs text-muted-foreground">
          {total} {total === 1 ? "thing" : "things"} to look at. Nothing changes until you decide.
          {total > findings.length ? ` Showing the oldest ${findings.length}.` : null}
        </p>
      </div>
      {GROUPS.map((group) => {
        const inGroup = findings.filter((finding) => group.kinds.includes(finding.kind));
        if (inGroup.length === 0) return null;
        const rows = inGroup.filter((finding, index) => index < ROWS_PER_GROUP || finding.id === openFindingId);
        const hidden = inGroup.length - rows.length;
        return (
          <section key={group.label} aria-label={group.label} className="flex flex-col gap-2">
            <h3 className="text-xs font-medium text-muted-foreground">{group.label}</h3>
            <ul className="flex flex-col gap-2">
              {rows.map((finding) => (
                <li key={finding.id}>
                  {finding.kind === "disagreement" && finding.other ? (
                    <Disagreement
                      finding={finding}
                      other={finding.other}
                      open={finding.id === openFindingId}
                      hrefs={hrefs}
                    />
                  ) : (
                    <div
                      id={`tidy-${finding.id}`}
                      className="flex flex-wrap items-start justify-between gap-2 rounded-lg border border-border px-3 py-2"
                    >
                      <p className="min-w-0 flex-1 text-body-dense break-words">{describe(finding, hrefs)}</p>
                      <DismissFinding
                        findingId={finding.id}
                        label={finding.kind === "duplicate" ? "Keep both" : "Looks fine"}
                      />
                    </div>
                  )}
                </li>
              ))}
            </ul>
            {hidden > 0 ? (
              <p className="text-xs text-muted-foreground">{hidden} more will show as you settle these.</p>
            ) : null}
          </section>
        );
      })}
    </section>
  );
}
