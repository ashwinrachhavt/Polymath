import type { ReactNode } from "react";
import { headingSlug } from "@/domains/knowledge/artifact-toc";
import { inline as renderInline } from "./markdown-inline";

/*
 * Artifact body rendering: the transcript markdown rules, scaled up for a
 * document. Headings keep their level and carry the slug id the
 * table-of-contents sidebar links to, so a heading jump lands on the real
 * section. Everything passes through React text nodes - no raw HTML.
 */

const headingClass: Record<number, string> = {
  1: "mt-2 text-2xl font-medium",
  2: "mt-8 text-xl font-medium",
  3: "mt-6 text-lg font-medium",
  4: "mt-4 text-base font-medium",
};

const isTableLine = (line: string) => line.trim().startsWith("|") && line.trim().endsWith("|");
const isSeparatorLine = (line: string) => /^\|?[\s:|-]+\|?$/.test(line.trim()) && line.includes("-");
const bullet = /^\s*[-*]\s+/;
const numbered = /^\s*\d+[.)]\s+/;

export function ArtifactMarkdown({ text }: { text: string }) {
  const blocks: ReactNode[] = [];
  const lines = text.split("\n");
  const seen = new Map<string, number>();
  let i = 0;
  let key = 0;

  while (i < lines.length) {
    if (lines[i].trim() === "") { i++; continue; }

    if (isTableLine(lines[i]) && i + 1 < lines.length && isSeparatorLine(lines[i + 1])) {
      const tableLines = [lines[i], lines[i + 1]];
      i += 2;
      while (i < lines.length && isTableLine(lines[i])) { tableLines.push(lines[i]); i++; }
      blocks.push(<Table key={key++} lines={tableLines} />);
      continue;
    }

    if (bullet.test(lines[i]) || numbered.test(lines[i])) {
      const ordered = numbered.test(lines[i]);
      const items: string[] = [];
      while (i < lines.length && (bullet.test(lines[i]) || numbered.test(lines[i]))) {
        items.push(lines[i].replace(bullet, "").replace(numbered, ""));
        i++;
      }
      const ListTag = ordered ? "ol" : "ul";
      blocks.push(
        <ListTag key={key++} className={`my-2 flex flex-col gap-1 pl-6 ${ordered ? "list-decimal" : "list-disc"}`}>
          {items.map((item, j) => <li key={j}>{renderInline(item)}</li>)}
        </ListTag>,
      );
      continue;
    }

    const heading = lines[i].match(/^(#{1,4})\s+(.*)$/);
    if (heading) {
      const level = heading[1].length;
      const headingText = heading[2];
      let id = headingSlug(headingText);
      if (seen.has(id)) {
        const n = seen.get(id)! + 1;
        seen.set(id, n);
        id = `${id}-${n}`;
      } else {
        seen.set(id, 1);
      }
      const Tag = `h${Math.min(level + 1, 6)}` as "h2" | "h3" | "h4" | "h5";
      blocks.push(
        <Tag key={key++} id={id} className={headingClass[level]}>
          {renderInline(headingText)}
        </Tag>,
      );
      i++;
      continue;
    }

    const para: string[] = [];
    while (i < lines.length && lines[i].trim() !== "" && !isTableLine(lines[i]) && !bullet.test(lines[i]) && !numbered.test(lines[i]) && !/^#{1,4}\s/.test(lines[i])) {
      para.push(lines[i].trim());
      i++;
    }
    blocks.push(<p key={key++}>{renderInline(para.join(" "))}</p>);
  }

  return <div className="flex flex-col gap-3 text-[15px] leading-7">{blocks}</div>;
}

function Table({ lines }: { lines: string[] }) {
  const [head, , ...body] = lines;
  const cells = (line: string) => line.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
  return (
    <table className="my-2 border-collapse text-[13px]">
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
