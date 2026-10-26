import { readNotionDiffPreview } from "@/domains/knowledge/diff-preview";

/*
 * The diff the owner approves for a Notion write (ASH-283). It shows the exact
 * lines that will be added, with the content hash the executor re-checks, so
 * the review is of the bytes that get written rather than of a summary.
 */
export function NotionDiff({
  capability,
  revision,
}: {
  capability: string;
  revision: { preview: unknown } | null;
}) {
  if (capability !== "notion.page.append" && capability !== "notion.page.create") return null;
  const diff = readNotionDiffPreview(revision?.preview, capability === "notion.page.append" ? "append" : "create");
  if (!diff) return null;
  return (
    <section aria-label="Notion diff" className="mb-4 text-[13px]">
      <p className="mb-2 text-xs text-muted-foreground">
        {capability === "notion.page.append" ? "Added to the end of" : "New page"}{" "}
        {diff.url ? (
          <a href={diff.url} target="_blank" rel="noreferrer" className="underline underline-offset-2">
            {diff.title || "the page"}
          </a>
        ) : (
          diff.title || "the page"
        )}
        {" · content "}
        <span className="font-mono">{diff.contentHash.slice(0, 12)}</span>
      </p>
      <div className="max-h-72 overflow-auto rounded-md border border-border bg-muted/40 py-1 font-mono text-xs">
        {diff.lines.map((line, index) =>
          line.kind === "gap" ? (
            <div key={index} className="px-3 text-muted-foreground">
              …
            </div>
          ) : (
            <div
              key={index}
              className={
                line.kind === "add"
                  ? "whitespace-pre-wrap break-words bg-emerald-500/10 px-3 text-emerald-900 dark:text-emerald-200"
                  : "whitespace-pre-wrap break-words px-3 text-muted-foreground"
              }
            >
              <span aria-hidden className="mr-2 select-none">
                {line.kind === "add" ? "+" : " "}
              </span>
              <span className="sr-only">{line.kind === "add" ? "Added: " : "Existing: "}</span>
              {line.text || " "}
            </div>
          ),
        )}
      </div>
    </section>
  );
}
