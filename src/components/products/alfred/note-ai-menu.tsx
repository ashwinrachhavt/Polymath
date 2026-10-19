"use client";

import { useState } from "react";
import { Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

export type NoteAIRequest = {
  action: "improve" | "shorten" | "summarize" | "translate" | "ask";
  selection: string;
  language?: string;
  question?: string;
};

/*
 * The functional Notebook AI menu. The donor's placeholder promised a
 * reviewable proposal; this menu collects the action, the passage it acts on
 * and any extra input (a target language, a question), and hands the request
 * to the parent, which runs it and stages the result for acceptance. Nothing
 * is generated or inserted here.
 */
export function NoteAIMenu({ selection, pending, onAction }: { selection: string; pending: boolean; onAction: (request: NoteAIRequest) => void }) {
  const [open, setOpen] = useState(false);
  const [language, setLanguage] = useState("");
  const [question, setQuestion] = useState("");
  const scope = selection.trim() ? `the selected passage (${selection.trim().length} characters)` : "the whole note";

  const fire = (request: Omit<NoteAIRequest, "selection">) => {
    onAction({ ...request, selection });
    setOpen(false);
    setQuestion("");
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button type="button" variant="outline" disabled={pending}>
          <Sparkles aria-hidden />
          {pending ? "AI is working…" : "Ask AI"}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogTitle>Notebook AI</DialogTitle>
        <DialogDescription>
          Acts on {scope}. The result arrives as a draft you can accept or discard; nothing is written into the note until you accept it.
        </DialogDescription>
        <div className="grid grid-cols-3 gap-2">
          <Button type="button" variant="outline" disabled={pending} onClick={() => fire({ action: "improve" })}>
            Improve writing
          </Button>
          <Button type="button" variant="outline" disabled={pending} onClick={() => fire({ action: "shorten" })}>
            Make shorter
          </Button>
          <Button type="button" variant="outline" disabled={pending} onClick={() => fire({ action: "summarize" })}>
            Summarize
          </Button>
        </div>
        <form
          className="flex items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (language.trim()) fire({ action: "translate", language: language.trim() });
          }}
        >
          <Input aria-label="Translate into" placeholder="Translate into…" value={language} onChange={(event) => setLanguage(event.target.value)} />
          <Button type="submit" variant="outline" disabled={pending || !language.trim()}>
            Translate
          </Button>
        </form>
        <form
          className="flex flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (question.trim()) fire({ action: "ask", question: question.trim() });
          }}
        >
          <Textarea
            aria-label="Ask about this page"
            rows={3}
            placeholder="Ask about this page — the answer cites the notes it used"
            value={question}
            onChange={(event) => setQuestion(event.target.value)}
          />
          <Button type="submit" variant="outline" className="w-fit" disabled={pending || !question.trim()}>
            Ask
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
