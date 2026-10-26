"use client";

import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import { recordLabel, recordPath, type RecordReference } from "./record-links";

/*
 * A record as the conversation shows it: the name, what it is, and where it
 * opens. The card is a real link on first paint — no client state, no fetch —
 * so a retrieved record is usable the moment it arrives in the stream.
 */
export function RecordCard({ record }: { record: RecordReference }) {
  const href = recordPath(record.kind, record.id);
  const body = (
    <>
      <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-muted-foreground/60" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] leading-5 font-medium text-foreground">{record.title}</span>
        <span className="block truncate text-[11.5px] leading-4 text-muted-foreground">
          {recordLabel(record.kind)}
          {record.subtitle ? ` · ${record.subtitle}` : ""}
        </span>
      </span>
      {href ? <ArrowUpRight aria-hidden className="size-3.5 shrink-0 text-muted-foreground/70" /> : null}
    </>
  );

  const className =
    "flex min-w-0 items-center gap-2 rounded-lg border border-border bg-card/60 px-2.5 py-1.5 transition-colors hover:border-ring/60 hover:bg-muted/50";

  if (!href) {
    return <div className={`${className} cursor-default`}>{body}</div>;
  }
  return (
    <Link href={href} className={className}>
      {body}
    </Link>
  );
}

/** The card list a tool result or an answer's references render as. */
export function RecordCards({ records }: { records: RecordReference[] }) {
  if (records.length === 0) return null;
  return (
    <div className="my-2 flex flex-col gap-1">
      {records.map((record) => (
        <RecordCard key={`${record.kind}:${record.id}`} record={record} />
      ))}
    </div>
  );
}
