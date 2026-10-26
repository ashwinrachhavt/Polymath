import { memo, type ReactNode } from "react";
import { inline } from "./markdown-inline";

/*
 * Just enough markdown for agent transcripts: bold, italic, inline code,
 * bullet and numbered lists, and pipe tables. Everything passes through React
 * text nodes - no dangerouslySetInnerHTML, no raw HTML - so model output can
 * only ever render as text, emphasis, lists, and tables. The inline rules
 * live in markdown-inline.tsx, shared with the artifact body renderer.
 */

const isTableLine = (line: string) => line.trim().startsWith("|") && line.trim().endsWith("|");
const isSeparatorLine = (line: string) => /^\|?[\s:|-]+\|?$/.test(line.trim()) && line.includes("-");
const cells = (line: string) => line.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
const fence = (line: string) => line.trim().match(/^(```|~~~)\s*([\w+-]*)\s*$/);

/** How an inline span becomes nodes. Defaults to the plain markdown rules. */
export type InlineRenderer = (text: string) => ReactNode;

/*
 * A fenced block is code by definition: no emphasis, no links, no list rules.
 * It carries its language as a quiet label rather than a syntax highlight, so
 * a fence renders as code on the first frame without a highlighter dependency.
 */
function CodeBlock({ language, lines }: { language: string; lines: string[] }) {
  return (
    <div className="my-1 overflow-hidden rounded-md border border-border">
      {language ? (
        <p className="text-muted-foreground border-b border-border bg-muted/40 px-3 py-1 text-[11px]">{language}</p>
      ) : null}
      <pre className="overflow-x-auto px-3 py-2">
        <code className="text-[13px] leading-5">{lines.join("\n")}</code>
      </pre>
    </div>
  );
}

function Table({ lines, renderInline }: { lines: string[]; renderInline: InlineRenderer }) {
  const [head, , ...body] = lines;
  return (
    <table className="my-1 border-collapse text-[13px]">
      <thead>
        <tr>
          {cells(head).map((c, i) => (
            <th key={i} className="border-border border px-2 py-1 text-left font-medium">{renderInline(c)}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {body.map((row, r) => (
          <tr key={r}>
            {cells(row).map((c, i) => (
              <td key={i} className="border-border border px-2 py-1 align-top">{renderInline(c)}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function markdown(raw: string, renderInline: InlineRenderer): ReactNode[] {
  const blocks: ReactNode[] = [];
  const lines = raw.split("\n");
  let i = 0;
  let key = 0;

  while (i < lines.length) {
    if (lines[i].trim() === "") { i++; continue; }

    // Fenced code: everything to the closing fence is literal text. Text after
    // the opener's language is kept as written and never parsed inline.
    const open = fence(lines[i]);
    if (open) {
      const [, marker, language = ""] = open;
      const body: string[] = [];
      i++;
      while (i < lines.length) {
        const close = fence(lines[i]);
        if (close && close[1] === marker) { i++; break; }
        body.push(lines[i]);
        i++;
      }
      blocks.push(<CodeBlock key={key++} language={language} lines={body} />);
      continue;
    }

    // Pipe table: header, separator, body rows.
    if (isTableLine(lines[i]) && i + 1 < lines.length && isSeparatorLine(lines[i + 1])) {
      const tableLines = [lines[i], lines[i + 1]];
      i += 2;
      while (i < lines.length && isTableLine(lines[i])) { tableLines.push(lines[i]); i++; }
      blocks.push(<Table key={key++} lines={tableLines} renderInline={renderInline} />);
      continue;
    }

    // Bullet or numbered list.
    const bullet = /^\s*[-*]\s+/;
    const numbered = /^\s*\d+[.)]\s+/;
    if (bullet.test(lines[i]) || numbered.test(lines[i])) {
      const ordered = numbered.test(lines[i]);
      const items: string[] = [];
      while (i < lines.length && (bullet.test(lines[i]) || numbered.test(lines[i]))) {
        items.push(lines[i].replace(bullet, "").replace(numbered, ""));
        i++;
      }
      const ListTag = ordered ? "ol" : "ul";
      blocks.push(
        <ListTag key={key++} className={`my-1 flex flex-col gap-0.5 ${ordered ? "list-decimal pl-7 marker:text-muted-foreground marker:font-normal" : "list-disc pl-5"}`}>
          {items.map((item, j) => <li key={j} className={ordered ? "pl-1" : undefined}>{renderInline(item)}</li>)}
        </ListTag>,
      );
      continue;
    }

    // Block quote: the `>` stays structural, everything else renders inside.
    if (lines[i].trimStart().startsWith(">")) {
      const quoted: string[] = [];
      while (i < lines.length && lines[i].trimStart().startsWith(">")) {
        quoted.push(lines[i].trimStart().replace(/^>\s?/, ""));
        i++;
      }
      blocks.push(
        <blockquote key={key++} className="border-border text-muted-foreground my-1 border-l-2 pl-3">
          {markdown(quoted.join("\n"), renderInline)}
        </blockquote>,
      );
      continue;
    }

    // Heading: keep the text, drop the #s.
    const heading = lines[i].match(/^#{1,4}\s+(.*)$/);
    if (heading) {
      blocks.push(<p key={key++} className="mt-1 font-medium text-foreground">{renderInline(heading[1])}</p>);
      i++;
      continue;
    }

    // Thematic break. A model uses `---` between sections; left as a
    // paragraph it renders the literal dashes into the answer.
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(lines[i])) {
      blocks.push(<hr key={key++} className="border-border my-1.5" />);
      i++;
      continue;
    }

    // Paragraph: join wrapped lines with a space, like markdown does.
    const para: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      !isTableLine(lines[i]) &&
      !bullet.test(lines[i]) &&
      !numbered.test(lines[i]) &&
      !/^#{1,4}\s/.test(lines[i]) &&
      !lines[i].trimStart().startsWith(">") &&
      !/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(lines[i]) &&
      !fence(lines[i])
    ) {
      para.push(lines[i].trim());
      i++;
    }
    blocks.push(<p key={key++}>{renderInline(para.join(" "))}</p>);
  }

  return blocks;
}

/**
 * Renders one message's markdown. Block structure is always parsed here; the
 * caller supplies how inline spans render, so a surface can add citations to
 * the same typography instead of re-implementing it.
 */
export const Markdown = memo(function Markdown({ text, renderInline }: { text: string; renderInline?: InlineRenderer }) {
  return <div className="flex flex-col gap-1.5">{markdown(text, renderInline ?? inline)}</div>;
});

/** The block renderer on its own, for callers that already supply a wrapper. */
export function MarkdownBlocks({ text, renderInline }: { text: string; renderInline?: InlineRenderer }) {
  return <>{markdown(text, renderInline ?? inline)}</>;
}
