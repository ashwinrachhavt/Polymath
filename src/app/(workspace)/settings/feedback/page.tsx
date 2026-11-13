import { io } from "next/cache";
import { Suspense } from "react";
import { Empty, Panel, Screen } from "@/components/workspace/ui";
import { RATING_FACES } from "@/components/feedback/rating-faces";
import { feedbackReadout, recentFeedbackComments, type FeedbackReadoutRow } from "@/domains/feedback/ratings";
import type { LlmFeedbackSurface } from "@/domains/feedback/schema";
import { modelById } from "@/domains/agents/models";
import { getAuthContext } from "@/lib/auth";
import { ForbiddenRoleError } from "@/lib/auth/guards";
import { timeAgo } from "@/lib/time";

export const metadata = { title: "Answer ratings · Polymath" };

/*
 * Answer ratings: how people scored what the models wrote, grouped the way a
 * fix is made — by surface, model and prompt version. Averages say where to
 * look; the distribution says whether an average hides a split; the notes say
 * why. An admin read, because it aggregates every member's ratings.
 */

const SURFACE_LABEL: Record<LlmFeedbackSurface, string> = {
  chat: "Chat answers",
  run: "Whole runs",
  quiz: "Quizzes",
  flashcards: "Flashcard decks",
  explain: "Explain It feedback",
  artifact: "Artifacts",
};

const average = (row: FeedbackReadoutRow) => (row.average === null ? "none graded" : row.average.toFixed(1));
const percent = (part: number, whole: number) => `${Math.round((part / whole) * 100)}%`;
/** A chat or run's prompt version is the agent profile revision's id; eight characters name it. */
const promptLabel = (version: string | null) =>
  version === null
    ? "not recorded"
    : /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(version)
      ? `profile ${version.slice(0, 8)}`
      : version;
const modelLabel = (model: string | null) => (model ? (modelById(model)?.label ?? model) : "Model not recorded");

function Distribution({ counts }: { counts: FeedbackReadoutRow["distribution"] }) {
  const max = Math.max(...counts, 1);
  return (
    <div className="flex items-end gap-1" aria-hidden>
      {counts.map((count, index) => (
        <div key={RATING_FACES[index].score} className="flex w-6 flex-col items-center gap-0.5">
          <div className="bg-muted flex h-8 w-3 items-end overflow-hidden rounded-sm">
            <div className="bg-foreground/60 w-full rounded-sm" style={{ height: `${(count / max) * 100}%` }} />
          </div>
          <span className="text-[11px] leading-none">{RATING_FACES[index].face}</span>
        </div>
      ))}
    </div>
  );
}

function distributionText(counts: FeedbackReadoutRow["distribution"]) {
  return counts.map((count, index) => `${count} rated ${RATING_FACES[index].score}`).join(", ");
}

async function Ratings() {
  await io();
  const auth = await getAuthContext();
  const description = "How people rated what the models wrote, by surface, model and prompt version.";
  let rows: FeedbackReadoutRow[];
  let notes: Awaited<ReturnType<typeof recentFeedbackComments>>;
  try {
    [rows, notes] = await Promise.all([feedbackReadout(auth), recentFeedbackComments(auth)]);
  } catch (error) {
    if (!(error instanceof ForbiddenRoleError)) throw error;
    return (
      <Screen title="Answer ratings" description={description}>
        <Empty title="Admins only" description="Ask a workspace owner or admin for the rating summary." />
      </Screen>
    );
  }
  if (rows.length === 0) {
    return (
      <Screen title="Answer ratings" description={description}>
        <Empty
          title="No ratings yet"
          description="Ratings appear here once someone picks a face under a chat answer, a quiz, a deck or an Explain It verdict."
        />
      </Screen>
    );
  }

  const surfaces = [...new Set(rows.map((row) => row.surface))];
  return (
    <Screen title="Answer ratings" description={description}>
      {surfaces.map((surface) => {
        const group = rows.filter((row) => row.surface === surface);
        const total = group.reduce((sum, row) => sum + row.count, 0);
        const down = group.reduce((sum, row) => sum + row.thumbsDown, 0);
        const graded = total - down;
        const weighted =
          graded === 0
            ? null
            : group.reduce((sum, row) => sum + (row.average ?? 0) * (row.count - row.thumbsDown), 0) / graded;
        const parts = [
          `${total} rating${total === 1 ? "" : "s"}`,
          weighted === null ? null : `average ${weighted.toFixed(1)} of 5 over ${graded} graded`,
          down > 0 ? `${percent(down, total)} thumbs-down` : null,
        ].filter((part) => part !== null);
        return (
          <Panel key={surface} title={SURFACE_LABEL[surface]} description={parts.join(" · ")}>
            <table className="w-full text-body-dense">
              <thead>
                <tr className="text-muted-foreground text-left text-xs">
                  <th className="pb-2 font-normal">Model</th>
                  <th className="pb-2 font-normal">Prompt version</th>
                  <th className="pb-2 text-right font-normal">Ratings</th>
                  {surface === "run" ? <th className="pb-2 text-right font-normal">Thumbs-down</th> : null}
                  <th className="pb-2 text-right font-normal">Average (graded)</th>
                  <th className="pb-2 pl-4 font-normal">Distribution</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {group.map((row) => (
                  <tr key={`${row.model}:${row.promptVersion}`}>
                    <td className="py-2 pr-3">{modelLabel(row.model)}</td>
                    <td className="text-muted-foreground py-2 pr-3 font-mono text-xs">
                      {promptLabel(row.promptVersion)}
                    </td>
                    <td className="py-2 text-right tabular-nums">{row.count}</td>
                    {surface === "run" ? (
                      <td className="py-2 text-right tabular-nums">
                        {row.thumbsDown} ({percent(row.thumbsDown, row.count)})
                      </td>
                    ) : null}
                    <td className="py-2 text-right tabular-nums">{average(row)}</td>
                    <td className="py-2 pl-4">
                      <span className="sr-only">{distributionText(row.distribution)}</span>
                      <Distribution counts={row.distribution} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Panel>
        );
      })}
      <Panel title="Notes" description="What people wrote with their rating, newest first.">
        {notes.length === 0 ? (
          <Empty title="No notes yet" description="A note is optional; none has been left." />
        ) : (
          <ul className="divide-y">
            {notes.map((note, index) => (
              <li key={index} className="flex items-start gap-3 py-2 text-body-dense">
                <span aria-label={note.score === 0 ? "Thumbs-down" : `${note.score} of 5`} className="leading-6">
                  {note.score === 0 ? "👎" : RATING_FACES[note.score - 1]?.face}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block">{note.comment}</span>
                  <span className="text-muted-foreground block text-xs">
                    {SURFACE_LABEL[note.surface]} · {modelLabel(note.model)}
                    {note.promptVersion ? ` · ${promptLabel(note.promptVersion)}` : ""} · {timeAgo(note.at)}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </Screen>
  );
}

/* io() must sit inside a Suspense boundary; see settings/page.tsx. */
export default function AnswerRatingsPage() {
  return (
    <Suspense
      fallback={
        <p role="status" className="p-6 text-body-dense text-muted-foreground">
          Loading ratings…
        </p>
      }
    >
      <Ratings />
    </Suspense>
  );
}
