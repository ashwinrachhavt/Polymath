"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { answerNotebookExplainItAction } from "./explain-actions";

type Evidence = { quote: string; source: { documentId: string; extractionId: string; title: string } };
type Turn = {
  id: string;
  ordinal: number;
  prompt: string;
  answer: string | null;
  grade: string | null;
  feedback: string | null;
  evidence: Evidence[];
};
type Session = { id: string; status: "active" | "completed"; title: string; turns: Turn[] };

export function ExplainItSession({ projectId, session }: { projectId: string; session: Session }) {
  const router = useRouter();
  const [answer, setAnswer] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const current = session.turns.at(-1);

  function submit() {
    if (!current || !answer.trim()) return;
    setError(null);
    startTransition(async () => {
      const result = await answerNotebookExplainItAction({
        projectId,
        sessionId: session.id,
        turnId: current.id,
        answer,
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setAnswer("");
      router.refresh();
    });
  }

  return (
    <section className="mx-auto w-full max-w-3xl">
      <p className="mb-4 text-sm text-muted-foreground">Sources: {session.title}</p>
      <ol className="space-y-4">
        {session.turns.map((turn) => (
          <li key={turn.id} className="rounded-xl border border-border p-5">
            <p className="mb-2 text-xs text-muted-foreground">Explain It · Question {turn.ordinal + 1}</p>
            <h2 className="font-medium leading-relaxed">{turn.prompt}</h2>
            {turn.answer !== null ? (
              <div className="mt-4 border-t border-border pt-4">
                <p className="whitespace-pre-wrap text-sm leading-relaxed">{turn.answer}</p>
                <p className="mt-3 font-medium capitalize">{turn.grade ?? "uncertain"}</p>
                <p className="mt-1 text-sm leading-relaxed">{turn.feedback}</p>
                {turn.evidence.length > 0 ? (
                  <ul className="mt-3 space-y-2">
                    {turn.evidence.map((evidence, index) => (
                      <li key={index} className="border-l-2 border-border pl-3 text-sm text-muted-foreground">
                        <blockquote>{evidence.quote}</blockquote>
                        <p className="mt-1 text-xs">{evidence.source.title}</p>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="mt-3 text-xs text-muted-foreground">
                    The source did not provide enough evidence to verify this answer.
                  </p>
                )}
              </div>
            ) : null}
          </li>
        ))}
      </ol>
      {session.status === "active" && current ? (
        <form
          className="mt-4 rounded-xl border border-border p-5"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <label htmlFor="explain-answer" className="text-sm font-medium">
            Explain it in your own words
          </label>
          <textarea
            id="explain-answer"
            value={answer}
            onChange={(event) => setAnswer(event.target.value)}
            maxLength={5000}
            rows={5}
            placeholder="Write your explanation…"
            className="mt-2 w-full resize-y rounded-md border border-border bg-background p-3 text-sm leading-relaxed outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
          <button
            type="submit"
            disabled={pending || !answer.trim()}
            className="mt-3 rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground disabled:opacity-50"
          >
            {pending ? "Checking against the sources…" : "Submit answer"}
          </button>
        </form>
      ) : (
        <div className="mt-4 rounded-xl border border-border p-5">
          <h2 className="font-medium">Session complete</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Your answers were checked against the pinned source versions. You can start another session from this
            Notebook.
          </p>
        </div>
      )}
      {error ? (
        <p role="alert" className="mt-3 text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </section>
  );
}
