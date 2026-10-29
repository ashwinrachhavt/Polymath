import Link from "next/link";
import { getAuthContext } from "@/lib/auth";
import { requireRole } from "@/lib/auth/guards";
import { listSittings } from "@/domains/knowledge/sittings";
import { Screen, Panel } from "@/components/workspace/ui";

export const metadata = { title: "Sittings · Ideas" };

/*
 * The "Sittings" destination (T8): open sittings first (one active at a
 * time, §14.8), then history. Multiple open sittings are allowed; each row
 * links into its shell.
 */
export default async function SittingsPage() {
  const auth = await getAuthContext();
  requireRole(auth, "member");
  const sittings = await listSittings(auth);
  const open = sittings.filter((s) => !s.endedAt);
  const past = sittings.filter((s) => s.endedAt);
  const stamp = (d: Date) => d.toLocaleString("en", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

  const Row = ({ sitting }: { sitting: (typeof sittings)[number] }) => (
    <li className="flex items-center justify-between gap-3 border-b border-border/60 py-2 last:border-0">
      <Link href={`/polymath/knowledge/zettels/session/${sitting.id}`} className="text-[13px] font-medium underline-offset-2 hover:underline">
        {sitting.topic?.trim() || "Untitled sitting"}
      </Link>
      <span className="flex items-center gap-2 text-xs text-muted-foreground">
        <span className={sitting.endedAt ? "" : "font-medium text-foreground"}>{sitting.endedAt ? "ended" : "open"}</span>
        <span>{stamp(sitting.startedAt)}</span>
      </span>
    </li>
  );

  return (
    <Screen
      title="Sittings"
      actions={
        <span className="flex items-center gap-3">
          <Link href="/polymath/knowledge/zettels/session/new" className="rounded-md bg-primary px-2.5 py-1 text-[13px] text-primary-foreground">New sitting</Link>
          <Link href="/polymath/knowledge/zettels" className="text-[13px] text-muted-foreground underline-offset-2 hover:underline">Back to Ideas</Link>
        </span>
      }
    >
      <Panel>
        <h2 className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">Open</h2>
        {open.length === 0 ? <p className="py-2 text-[13px] text-muted-foreground">No open sittings. Start one and the cards you write land here.</p> : <ul>{open.map((s) => <Row key={s.id} sitting={s} />)}</ul>}
      </Panel>
      {past.length > 0 && (
        <Panel>
          <h2 className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">History</h2>
          <ul>{past.map((s) => <Row key={s.id} sitting={s} />)}</ul>
        </Panel>
      )}
    </Screen>
  );
}
