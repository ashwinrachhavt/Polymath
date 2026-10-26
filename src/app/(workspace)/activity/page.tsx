import { io } from "next/cache";
import { PageHeader } from "@/components/page-header";
import { EmptyState } from "@/components/empty-state";
import { getAuthContext } from "@/lib/auth";
import { listWorkspaceActivity } from "@/domains/audit/queries";

export const metadata = { title: "Activity · Polymath" };

/*
 * The real Activity rail: the workspace's audit events, written by every
 * domain through recordAudit (ASH-131). The rail previously rendered the
 * browser-preview activity component, so real writes had no read surface -
 * this page is that surface, workspace-scoped like every canonical screen.
 */
export default async function ActivityPage() {
  await io();
  if (!process.env.DATABASE_URL?.trim()) {
    return (
      <>
        <PageHeader title="Activity" purpose="What changed in this workspace." />
        <div className="page-content">
          <EmptyState title="Activity storage is not configured" description="Set DATABASE_URL and apply the database migrations to record and read workspace activity." />
        </div>
      </>
    );
  }
  const auth = await getAuthContext();
  const rows = await listWorkspaceActivity(auth);
  return (
    <>
      <PageHeader title="Activity" purpose="What changed in this workspace." />
      <div className="page-content">
        {rows.length === 0 ? (
          <EmptyState title="No activity yet" description="Workspace actions - captures, decisions, calendar and day changes - are recorded here as they happen." />
        ) : (
          <ul className="divide-y divide-border">
            {rows.map((row, i) => (
              <li key={i} className="flex items-baseline justify-between gap-4 py-2.5 text-[13px]">
                <div className="min-w-0">
                  <p className="truncate">{row.summary}</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {row.action} · {row.actorKind} · {row.subjectType}
                  </p>
                </div>
                <time className="readout shrink-0 text-xs text-muted-foreground" dateTime={row.createdAt.toISOString()}>
                  {row.createdAt.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
                </time>
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
}
