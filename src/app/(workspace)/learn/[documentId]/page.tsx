import Link from "next/link";
import { notFound } from "next/navigation";
import { io } from "next/cache";
import { Suspense } from "react";
import { Panel, Screen } from "@/components/workspace/ui";
import { listUnfinishedGenerationJobs } from "@/domains/jobs/queries";
import { LEARNING_JOB_KIND_PREFIX, learningJobSubject } from "@/domains/learning/job-names";
import { getLearnLibrary, getQuizForSitting } from "@/domains/learning/queries";
import { getArtifactFeedback } from "@/domains/knowledge/artifact-feedback";
import { getAuthContext } from "@/lib/auth";
import { GenerateQuizButton } from "../quiz-action";
import { QuizRunner } from "./quiz-runner";

export const metadata = { title: "Quiz · Polymath" };

/*
 * The quiz shell for one document. Three honest states: a document still
 * being read (no extraction to quiz against), one without a quiz yet, and
 * a ready quiz with its runner. The learning state (best score, attempts)
 * is the library's; this page re-derives it from the same query rather
 * than inventing a second read.
 */
async function QuizShell({ documentId }: { documentId: string }) {
  await io();
  const auth = await getAuthContext();
  const rows = await getLearnLibrary(auth);
  const row = rows.find((r) => r.documentId === documentId);
  if (!row) notFound();

  if (!row.quizzable) {
    return (
      <Screen title={row.title} description="Still reading this document.">
        <Panel title="Not ready to quiz">
          <p className="text-body-dense text-muted-foreground">
            Quizzes are built from a document&apos;s read text, and this one has none yet. Its state shows honestly on
            the Learn page the moment reading finishes.
          </p>
          <Link
            href="/learn"
            className="mt-3 inline-block text-body-dense font-medium underline-offset-4 hover:underline"
          >
            Back to Learn
          </Link>
        </Panel>
      </Screen>
    );
  }

  const [quiz, quizJobs] = await Promise.all([
    row.quizId ? getQuizForSitting(auth, row.quizId) : null,
    listUnfinishedGenerationJobs(auth, {
      kindPrefix: LEARNING_JOB_KIND_PREFIX,
      subject: learningJobSubject.document(documentId),
    }),
  ]);
  if (!quiz) {
    return (
      <Screen title={row.title} description="No quiz yet.">
        <Panel
          title="No quiz yet"
          description="Generate a short graded quiz from this document's text. Finishing one earns stones."
        >
          <GenerateQuizButton documentId={row.documentId} initialJobs={quizJobs} />
          <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
            Generation is verified, never padded: every question must quote the document verbatim, and if too few prove
            out, generation says so instead of shipping a weak quiz.
          </p>
        </Panel>
        <Link href="/learn" className="text-body-dense font-medium underline-offset-4 hover:underline">
          Back to Learn
        </Link>
      </Screen>
    );
  }

  const rating = await getArtifactFeedback(auth, { kind: "quiz", id: quiz.id });
  return (
    <Screen
      title={row.title}
      description={
        row.bestCorrect !== null
          ? `Best score ${row.bestCorrect}/${row.questionCount ?? quiz.questions.length} on the latest quiz.`
          : "A short graded quiz over what you saved."
      }
      actions={<GenerateQuizButton documentId={row.documentId} initialJobs={quizJobs} label="Regenerate" />}
    >
      <QuizRunner quiz={quiz} rating={rating} />
      <Link href="/learn" className="text-body-dense font-medium underline-offset-4 hover:underline">
        Back to Learn
      </Link>
    </Screen>
  );
}

export default function DocumentQuizPage({ params }: { params: Promise<{ documentId: string }> }) {
  return (
    <Suspense
      fallback={
        <p role="status" className="p-6 text-body-dense text-muted-foreground">
          Opening the quiz…
        </p>
      }
    >
      <QuizShellFromParams params={params} />
    </Suspense>
  );
}

async function QuizShellFromParams({ params }: { params: Promise<{ documentId: string }> }) {
  const { documentId } = await params;
  return <QuizShell documentId={documentId} />;
}
