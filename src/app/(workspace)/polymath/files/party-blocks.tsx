import type { DocumentReviewParty } from "@/domains/knowledge/queries";

/*
 * From and Bill-to side by side (ASH-128). The roles are never conflated: From
 * is the issuer or sender, Bill to is the recipient. Each block shows the name
 * as written on the document and, once resolved, the profile it came from, so
 * the owner sees whether a name is a CRM record or only text on a page.
 */

const FROM_ROLES = ["issuer", "sender"] as const;
const TO_ROLES = ["recipient"] as const;

function sourceLine(p: DocumentReviewParty): string {
  const profile = p.contactName ?? p.companyName;
  if (profile) return `Profile: ${profile} (${p.partyKind === "contact" ? "contact" : "company"})`;
  return p.resolutionStatus === "ambiguous" ? "Several profiles match - pick one in review" : "From the document - no profile yet";
}

function Block({ label, parties }: { label: string; parties: DocumentReviewParty[] }) {
  return (
    <div className="border-border flex min-w-0 flex-1 flex-col gap-1 rounded-md border p-2.5">
      <h4 className="text-muted-foreground text-xs">{label}</h4>
      {parties.length === 0 ? (
        <p className="text-muted-foreground text-xs">Not found on the document</p>
      ) : (
        parties.map((p) => (
          <div key={p.id} className="flex flex-col">
            <span className="truncate text-[13px] font-medium">{p.contactName ?? p.companyName ?? p.displayName}</span>
            {p.contactName || p.companyName ? (
              p.displayName !== (p.contactName ?? p.companyName) ? (
                <span className="text-muted-foreground truncate text-xs">Written as &quot;{p.displayName}&quot;</span>
              ) : null
            ) : null}
            <span className="text-muted-foreground text-xs">{sourceLine(p)}</span>
          </div>
        ))
      )}
    </div>
  );
}

export function PartyBlocks({ parties }: { parties: DocumentReviewParty[] }) {
  const from = parties.filter((p) => (FROM_ROLES as readonly string[]).includes(p.partyRole));
  const to = parties.filter((p) => (TO_ROLES as readonly string[]).includes(p.partyRole));
  const others = parties.filter((p) => !from.includes(p) && !to.includes(p));
  return (
    <section className="flex flex-col gap-2">
      <div className="flex gap-2">
        <Block label="From" parties={from} />
        <Block label="Bill to" parties={to} />
      </div>
      {others.length > 0 ? (
        <p className="text-muted-foreground text-xs">
          Also on the document: {others.map((p) => `${p.contactName ?? p.companyName ?? p.displayName} (${p.partyRole})`).join(", ")}
        </p>
      ) : null}
    </section>
  );
}
