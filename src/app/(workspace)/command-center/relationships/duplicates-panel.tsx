"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Panel } from "@/components/workspace/ui";
import type { DuplicateGroup } from "@/domains/crm/dedupe";
import { mergeCompaniesAction, mergeContactsAction } from "./actions";

/*
 * C01 dedupe controls. Each candidate group lists the doubles the server
 * found; the owner picks the record to keep, the merge re-points every child
 * row and archives the loser in one transaction. Nothing merges on its own.
 */

function Group({
  group,
  kind,
}: {
  group: DuplicateGroup;
  kind: "contact" | "company";
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function merge(keep: DuplicateGroup["rows"][number], others: DuplicateGroup["rows"]) {
    const losing = others.filter((row) => row.id !== keep.id);
    if (!window.confirm(
      `Merge ${losing.map((row) => row.label).join(", ")} into ${keep.label}? Linked history moves to the kept record; the duplicate is archived.`,
    )) return;
    setError(null);
    startTransition(async () => {
      // One merge per click: larger groups converge over successive merges.
      const action = kind === "contact" ? mergeContactsAction : mergeCompaniesAction;
      const result = await action({
        sourceId: losing[0].id,
        targetId: keep.id,
        expectedTargetVersion: keep.version,
      });
      if (!result.ok) { setError(result.error); return; }
      router.refresh();
    });
  }

  return (
    <div className="rounded-md border border-border p-3">
      <p className="text-[11px] font-medium text-muted-foreground">{group.reason}</p>
      <ul className="mt-2 space-y-2">
        {group.rows.map((row) => (
          <li key={row.id} className="flex flex-wrap items-center gap-2 text-[13px]">
            <span className="min-w-0 flex-1 truncate">
              <span className="font-medium">{row.label}</span>
              {row.detail ? <span className="text-muted-foreground"> · {row.detail}</span> : null}
            </span>
            <Button variant="outline" size="sm" disabled={pending} onClick={() => merge(row, group.rows)}>
              {pending ? "Merging…" : "Keep this record"}
            </Button>
          </li>
        ))}
      </ul>
      {group.rows.length > 2 ? (
        <p className="mt-2 text-[11px] text-muted-foreground">One merge happens per click; the group shrinks until one record remains.</p>
      ) : null}
      {error ? <p className="mt-2 text-[13px] text-destructive" role="alert">{error}</p> : null}
    </div>
  );
}

export function DuplicatesPanel({
  contactGroups,
  companyGroups,
}: {
  contactGroups: DuplicateGroup[];
  companyGroups: DuplicateGroup[];
}) {
  if (!contactGroups.length && !companyGroups.length) return null;
  return (
    <Panel
      title="Possible duplicates"
      description="Records that share an email, phone, domain or name. Merging re-points every linked record to the one you keep and archives the duplicate; it is never automatic."
    >
      <div className="grid gap-3 md:grid-cols-2">
        {[...contactGroups.map((group) => ({ group, kind: "contact" as const })), ...companyGroups.map((group) => ({ group, kind: "company" as const }))].map(({ group, kind }, index) => (
          <Group key={`${kind}-${index}`} group={group} kind={kind} />
        ))}
      </div>
    </Panel>
  );
}
