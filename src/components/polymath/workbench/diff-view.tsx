/*
 * The diff renderer (Workbench D2): the stored checkpoint diff, shown verbatim
 * in a collapsed block so a reader opens it when they want the bytes and skips
 * it when the summary answers their question. Line tints follow the diff's own
 * +/- grammar using semantic tokens; the truncation note is explicit that it is
 * display-only — the stored checkpoint always holds the complete diff.
 */
const DISPLAY_LINE_LIMIT = 600;

export function DiffView({ diffText, lineLimit = DISPLAY_LINE_LIMIT }: { diffText: string; lineLimit?: number }) {
  const lines = diffText.split("\n");
  // A trailing newline produces one empty final split segment; it is not a diff line.
  const contentLines = lines.length > 1 && lines[lines.length - 1] === "" ? lines.slice(0, -1) : lines;
  const truncated = contentLines.length > lineLimit;
  const shown = truncated ? contentLines.slice(0, lineLimit) : contentLines;

  return (
    <details className="group rounded-md border border-border/70 bg-muted/30">
      <summary className="text-muted-foreground cursor-pointer list-none px-3 py-2 text-[12px] transition-colors hover:text-foreground [&::-webkit-details-marker]:hidden">
        <span className="group-open:hidden">View diff ({contentLines.length} lines)</span>
        <span className="hidden group-open:inline">Hide diff</span>
      </summary>
      <pre className="overflow-x-auto border-t border-border/70 px-3 py-2 font-mono text-[11px] leading-5">
        {shown.map((line, index) => (
          <span key={index} className={`block ${lineClass(line)}`}>
            {line === "" ? " " : line}
          </span>
        ))}
      </pre>
      {truncated ? (
        <p className="text-muted-foreground border-t border-border/70 px-3 py-2 text-[11px]">
          Display truncated at {lineLimit} of {contentLines.length} lines. The stored checkpoint holds the complete diff.
        </p>
      ) : null}
    </details>
  );
}

function lineClass(line: string): string {
  // File headers and hunk markers are chrome, not content; they tint like meta
  // so the +/- lines that carry the change stand out on their own grammar.
  if (line.startsWith("diff --git ") || line.startsWith("index ") || line.startsWith("---") || line.startsWith("+++")) {
    return "text-muted-foreground";
  }
  if (line.startsWith("@@")) return "text-muted-foreground/80";
  if (line.startsWith("+")) return "text-success";
  if (line.startsWith("-")) return "text-destructive";
  return "";
}
