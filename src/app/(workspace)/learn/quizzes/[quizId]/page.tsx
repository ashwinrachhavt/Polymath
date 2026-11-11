import Link from "next/link";
import { notFound } from "next/navigation";
import { io } from "next/cache";
import { Suspense } from "react";
import { z } from "zod";
import { Screen } from "@/components/workspace/ui";
import { getArtifactFeedback } from "@/domains/knowledge/artifact-feedback";
import { getQuizForSitting } from "@/domains/learning/queries";
import { getAuthContext } from "@/lib/auth";
import { QuizRunner } from "../../[documentId]/quiz-runner";

export const metadata = { title: "Quiz · Polymath" };

/* One quiz by id: where a quiz made from picked sources opens. */
export default function LearnQuizPage({ params }: { params: Promise<{ quizId: string }> }) {
  return (
    <Suspense
      fallback={
        <p role="status" className="p-6 text-body-dense text-muted-foreground">
          Opening the quiz…
        </p>
      }
    >
      <QuizSitting params={params} />
    </Suspense>
  );
}

async function QuizSitting({ params }: { params: Promise<{ quizId: string }> }) {
  await io();
  const { quizId } = await params;
  if (!z.uuid().safeParse(quizId).success) notFound();
  const auth = await getAuthContext();
  const quiz = await getQuizForSitting(auth, quizId);
  if (!quiz) notFound();
  const rating = await getArtifactFeedback(auth, { kind: "quiz", id: quiz.id });
  const sources = quiz.sourceManifest.map((source) => source.title).join(", ");
  return (
    <Screen title={quiz.title} description={`From ${sources}`}>
      <QuizRunner quiz={quiz} rating={rating} />
      <Link href="/learn" className="text-body-dense font-medium underline-offset-4 hover:underline">
        Back to Learn
      </Link>
    </Screen>
  );
}
