import Link from "next/link";
import { io } from "next/cache";
import { Suspense } from "react";
import { EmptyState } from "@/components/empty-state";
import { WorkStatus } from "@/components/work-status";
import { Empty, Panel, Screen, Stat } from "@/components/workspace/ui";
import { getRewardsOverview } from "@/domains/gamification/queries";
import { getLearnLibrary, type LearnLibraryRow } from "@/domains/learning/queries";
import { getAuthContext } from "@/lib/auth";
import { GenerateQuizButton } from "./quiz-action";

export const metadata = { title: "Learn · Polymath" };

/*
 * The learning library (learn-harness replication): every captured document
 * with its learning state, and the stones the loop has earned. The balance
 * is derived from the reward ledger at render - never a stored number - and
 * the rail carries no chip for it (ASH-164: a badge from one source over a
 * page fed by another is a number that lies).
 */

const attemptedDate = new Intl.DateTimeFormat("en", { month: "short", day: "numeric" });

/** The state a row shows: never a number for a quiz the user cannot retake. */
function learningState(row: LearnLibraryRow): string {
  if (!row.quizzable) return "Still reading this document";
  if (!row.quizId) return "Not quizzed";
  if (row.bestCorrect === null) return "Not attempted yet";
  return `Best score ${row.bestCorrect}/${row.questionCount}`;
}

/**
 * Raw SQL aggregates bypass drizzle's column mapping, so an attempt
 * timestamp arrives as the driver's text form or a Date depending on the
 * pg wire round-trip. A display hint must never take the screen down over
 * either, so format only what parses and hide the rest.
 */
function formatAttempted(value: string | Date | null): string | null {
  if (value === null) return null;
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? attemptedDate.format(time) : null;
}

function LibraryList({ rows }: { rows: LearnLibraryRow[] }) {
  return (
    <ul className="flex flex-col">
      {rows.map((row) => {
        const attempted = formatAttempted(row.lastAttemptedAt);
        return (
          <li
            key={row.documentId}
            className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md px-2 py-2 hover:bg-muted"
          >
            <Link
              href={`/learn/${row.documentId}`}
              className="min-w-0 flex-1 truncate text-[13px] font-medium underline-offset-4 hover:underline"
            >
              {row.title}
            </Link>
            <span className="text-xs text-muted-foreground">{learningState(row)}</span>
            {attempted ? <span className="text-xs text-muted-foreground">last attempted {attempted}</span> : null}
            {row.lastFailure ? (
              <WorkStatus
                state={{ phase: "failed", label: `Last generation failed: ${row.lastFailure}` }}
                className="w-full"
              />
            ) : null}
            {row.quizzable ? (
              row.quizId ? (
                <Link
                  href={`/learn/${row.documentId}`}
                  className="text-[13px] font-medium underline-offset-4 hover:underline"
                >
                  Retake
                </Link>
              ) : (
                <GenerateQuizButton documentId={row.documentId} />
              )
            ) : (
              <GenerateQuizButton documentId={row.documentId} disabled />
            )}
          </li>
        );
      })}
    </ul>
  );
}

async function LearnSurface() {
  await io();
  const auth = await getAuthContext();
  const [rows, overview] = await Promise.all([getLearnLibrary(auth), getRewardsOverview(auth)]);
  const quizzable = rows.filter((row) => row.quizzable).length;

  const stats = (
    <div className="grid gap-4 sm:grid-cols-2">
      <Stat label="Stones earned" value={overview.totalPoints} hint="Derived from the ledger, never stored" />
      <Stat
        label="Documents ready to quiz"
        value={`${quizzable} of ${rows.length}`}
        hint="A document is ready once its text is read"
      />
    </div>
  );

  if (rows.length === 0) {
    return (
      <Screen title="Learn">
        {stats}
        <EmptyState
          title="Nothing to learn from yet"
          description="Capture an article in the vault and it will show up here, ready to become a quiz."
          action={
            <Link
              href="/polymath/knowledge"
              className="inline-flex h-7 items-center rounded-md border border-border px-2.5 text-[13px] font-medium underline-offset-4 hover:underline"
            >
              Open the vault
            </Link>
          }
        />
      </Screen>
    );
  }

  return (
    <Screen title="Learn" description="Every captured document, ready to become a quiz. Finishing one earns stones.">
      {stats}

      <Panel title="Your documents" description="Generate a quiz from what you captured, or retake the latest one.">
        <LibraryList rows={rows} />
        {!rows.some((row) => row.quizzable) ? (
          <Empty
            title="No document is ready yet"
            description="Quizzes are built from a document's read text. Ones still being read show an honest state above."
          />
        ) : null}
      </Panel>
    </Screen>
  );
}

export default function LearnPage() {
  return (
    <Suspense
      fallback={
        <p role="status" className="p-6 text-[13px] text-muted-foreground">
          Opening the learning library…
        </p>
      }
    >
      <LearnSurface />
    </Suspense>
  );
}
