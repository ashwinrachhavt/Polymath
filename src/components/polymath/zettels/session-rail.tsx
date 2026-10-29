"use client";

/*
 * The SessionRail (§14.1, §14.8): the sitting's name and its cards. Cards
 * land here on card_saved; the empty state is the §14.1 hint.
 */
export function SessionRail({
  topic,
  cards,
}: {
  topic: string | null;
  cards: { artifactId: string; role: string }[];
}) {
  return (
    <nav aria-label="Sitting cards" className="flex w-56 shrink-0 flex-col gap-2 border-r border-border p-4 max-lg:border-r-0 max-lg:border-b">
      <h2 className="font-mono text-xs uppercase tracking-wide text-muted-foreground">
        {topic?.trim() || "Untitled sitting"}
      </h2>
      {cards.length === 0 ? (
        <p className="text-sm text-muted-foreground">Cards you write land here</p>
      ) : (
        <ul className="flex flex-col gap-1">
          {cards.map((card) => (
            <li key={card.artifactId} className="rounded border border-border px-2 py-1 text-sm">
              <a href={`/polymath/knowledge/cards?id=${card.artifactId}`} className="flex min-h-11 items-center underline-offset-2 hover:underline">
                Card
              </a>{" "}
              <span className="font-mono text-[10px] text-muted-foreground">{card.role}</span>
            </li>
          ))}
        </ul>
      )}
    </nav>
  );
}
