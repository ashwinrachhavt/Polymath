import Link from "next/link";
import type { MissionView } from "@/domains/learning/missions";
import { MissionDelete } from "./mission-delete";

/*
 * The Missions on Learn: what each one asks for, by when, and where it
 * stands. One card per Mission, newest first; the primary action is opening
 * the one that needs work, and starting a new Mission is the one button.
 * Deleting archives the Mission; the toast's undo restores its old status.
 */

function dueLabel(dueOn: string | null): string {
  if (!dueOn) return "No date";
  const due = new Date(dueOn + "T00:00:00Z");
  const today = new Date();
  const days = Math.ceil(
    (due.getTime() - Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate())) / 86_400_000,
  );
  if (days < 0) return "Date passed";
  if (days === 0) return "Today";
  if (days === 1) return "Tomorrow";
  return `${days} days left`;
}

export function MissionList({ missions }: { missions: MissionView[] }) {
  return (
    <section aria-labelledby="missions-title" className="panel mt-4 rounded-xl p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="missions-title" className="font-medium">
          Missions
        </h2>
        <Link
          href="/learn/missions/new"
          className="shrink-0 rounded-md border border-border px-3 py-1.5 text-sm font-medium hover:bg-muted"
        >
          New Mission
        </Link>
      </div>
      {missions.length === 0 ? (
        <p className="mt-3 text-sm text-muted-foreground">No Missions yet.</p>
      ) : (
        <ul className="mt-3 divide-y divide-border">
          {missions.map((mission) => (
            <li key={mission.id} className="flex items-center justify-between gap-3 py-3 first:pt-0 last:pb-0">
              <div className="min-w-0">
                <Link href={`/learn/missions/${mission.id}`} className="font-medium underline-offset-4 hover:underline">
                  {mission.goal}
                </Link>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {mission.status === "draft" ? "Not started" : "In progress"} · {dueLabel(mission.dueOn)} ·{" "}
                  {mission.concepts.length} concept{mission.concepts.length === 1 ? "" : "s"}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <Link
                  href={
                    mission.status === "draft" ? `/learn/missions/${mission.id}` : `/learn/missions/${mission.id}/mock`
                  }
                  className="text-sm underline underline-offset-4"
                >
                  {mission.status === "draft" ? "Review the plan" : "Take the mock"}
                </Link>
                {/* listMissions never returns an archived Mission, so the status to restore is one of these. */}
                <MissionDelete missionId={mission.id} status={mission.status === "draft" ? "draft" : "active"} />
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
