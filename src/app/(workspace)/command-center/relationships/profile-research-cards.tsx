import type { PersistedCardSet } from "@/domains/knowledge/profile-research";

/*
 * The grounded card set on a profile (ASH-291). Server-rendered from the
 * persisted research artifact: each card shows its kind, the text, and the
 * manifest citations its claims rest on; the manifest lists every source
 * with when it was retrieved. A run that grounded nothing renders the
 * honest empty state, and ungrounded cards are a recorded gap count, never
 * shown as content.
 */

const KIND_LABELS: Record<string, string> = {
  overview: "Overview",
  offerings: "Offerings",
  news: "News",
  watch: "Watch",
  background: "Background",
  role: "Current role",
  mentions: "Recent mentions",
  "talking-points": "Talking points",
};

const FOCUS_LABELS: Record<string, string> = {
  profile: "Full profile",
  background: "Background",
  mentions: "Recent mentions",
  "talking-points": "Talking points",
};

export function ProfileResearchCards({ cardSet }: { cardSet: PersistedCardSet }) {
  const generated = new Date(cardSet.generatedAt);
  return (
    <div className="space-y-4" data-testid="profile-research-result">
      <p className="text-xs text-muted-foreground">
        {FOCUS_LABELS[cardSet.focus] ?? cardSet.focus} · {cardSet.cards.length} {cardSet.cards.length === 1 ? "card" : "cards"} from{" "}
        {cardSet.manifest.length} {cardSet.manifest.length === 1 ? "source" : "sources"} ·{" "}
        {generated.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
        {cardSet.gaps > 0 ? (
          <span>
            {" "}
            · <span className="font-medium">{cardSet.gaps} {cardSet.gaps === 1 ? "card" : "cards"} dropped</span> - the sources could not ground them
          </span>
        ) : null}
      </p>

      {cardSet.cards.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border bg-muted/30 p-4 text-[13px] text-muted-foreground" role="note">
          Insufficient evidence. The research pass found no sources it could ground a card in. This is a recorded gap, not a summary.
        </div>
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2">
          {cardSet.cards.map((card, i) => (
            <li key={i} className="panel flex min-w-0 flex-col gap-1.5 rounded-xl p-4">
              <p className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">{KIND_LABELS[card.kind] ?? card.kind}</p>
              <p className="text-[13px] font-medium">{card.title}</p>
              <p className="text-[13px] leading-relaxed text-muted-foreground">{card.body}</p>
              <p className="mt-auto flex flex-wrap gap-1.5 pt-1">
                {card.citations.map((n) => {
                  const source = cardSet.manifest[n - 1];
                  if (!source) return null;
                  return (
                    <a
                      key={n}
                      href={source.url}
                      target="_blank"
                      rel="noreferrer"
                      title={source.title}
                      className="rounded-sm border border-border bg-muted/60 px-1.5 text-[11px] font-medium text-foreground underline-offset-2 hover:underline"
                    >
                      S{n}
                    </a>
                  );
                })}
              </p>
            </li>
          ))}
        </ul>
      )}

      {cardSet.manifest.length > 0 ? (
        <details>
          <summary className="cursor-pointer text-[13px] font-medium focus-visible:outline-2 focus-visible:outline-ring">
            Sources ({cardSet.manifest.length})
          </summary>
          <ul className="mt-2 space-y-1.5">
            {cardSet.manifest.map((m) => (
              <li key={m.ref} className="text-xs text-muted-foreground">
                <span className="font-medium text-foreground">[{m.ref}]</span>{" "}
                <a href={m.url} target="_blank" rel="noreferrer" className="underline underline-offset-2 hover:text-foreground">
                  {m.title}
                </a>
                {m.publishedAt ? ` · published ${m.publishedAt.slice(0, 10)}` : " · undated"} · retrieved {m.retrievedAt.slice(0, 10)}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}
