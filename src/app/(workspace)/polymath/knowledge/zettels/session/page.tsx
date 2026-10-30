import Link from "next/link";
import { getAuthContext } from "@/lib/auth";
import { requireRole } from "@/lib/auth/guards";
import { listSittings } from "@/domains/knowledge/sittings";
import { Screen, Panel } from "@/components/workspace/ui";

export const metadata = { title: "Sittings · Ideas" };

/*
 * The "Sittings" destination (T8): a plain history of writing contexts
 * (Gate 2026-10-29: no lifecycle - no open/closed split, no status badges).
 * Each row links into its workspace, which is always writable.
 */
export default async function SittingsPage() {
  const auth = await getAuthContext();
  requireRole(auth, "member");
  const sittings = await listSittings(auth);
  const stamp = (d: Date) => d.toLocaleString("en", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

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
        {sittings.length === 0 ? (
          <p className="py-2 text-[13px] text-muted-foreground">No sittings yet. Start one and the cards you write land here.</p>
        ) : (
          <ul>
            {sittings.map((sitting) => (
              <li key={sitting.id} className="flex items-center justify-between gap-3 border-b border-border/60 py-2 last:border-0">
                <Link href={`/polymath/knowledge/zettels/session/${sitting.id}`} className="text-[13px] font-medium underline-offset-2 hover:underline">
                  {sitting.topic?.trim() || "Untitled sitting"}
                </Link>
                <span className="text-xs text-muted-foreground">{stamp(sitting.startedAt)}</span>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </Screen>
  );
}
