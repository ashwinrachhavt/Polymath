"use client";

import { useId, useState, useTransition } from "react";
import { AnimatePresence, motion } from "motion/react";
import { SmilePlus } from "lucide-react";
import { cn } from "cn";
import type { RatedOutput, Rating } from "@/domains/feedback/ratings";
import { RATING_FACES } from "./rating-faces";
import { rateOutputAction } from "./rate-output-action";

/*
 * The one rating control under every model output: five faces from 😞 to 😄,
 * scored 1-5 (domains/feedback). It rests as a single quiet face in the
 * output's action row. Opening it lays the five faces out inline — no popover,
 * nothing that waits in a dialog — and a pick closes it back to the chosen
 * face. Picking the chosen face again clears the rating. After a pick, an
 * optional one-line note can say why; it is never required.
 *
 * The open faces are a radio group: one Tab stop, arrow keys move between
 * faces, Escape closes, and each face is announced by name ("4 of 5, good"),
 * not by glyph. Faces are the system's Unicode emoji, shown slightly
 * desaturated at rest so a row of them never shouts in a transcript.
 */

const faceOf = (score: number) => RATING_FACES.find((entry) => entry.score === score) ?? RATING_FACES[2];

export function OutputRating({
  output,
  initial,
  label = "Rate this answer",
  prompt,
  startOpen = false,
  onChange,
  className,
}: {
  output: RatedOutput;
  initial: Rating | null;
  /** What the group is called for assistive tech, e.g. "Rate this quiz". */
  label?: string;
  /** A visible question before the control, for surfaces where the rating is not in an action row. */
  prompt?: string;
  /** Open on the five faces, for a surface whose own control means "grade it now". */
  startOpen?: boolean;
  /** Called with the saved rating once the server confirms it (null = cleared). */
  onChange?: (rating: Rating | null) => void;
  className?: string;
}) {
  const [rating, setRating] = useState<Rating | null>(initial);
  const [open, setOpen] = useState(startOpen);
  // Focus goes back to the resting face after a pick or Escape, never on first paint.
  const [refocus, setRefocus] = useState(false);
  const [noteOpen, setNoteOpen] = useState(false);
  const [note, setNote] = useState(initial?.comment ?? "");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const noteId = useId();

  function save(score: number | null, comment?: string | null) {
    setError(null);
    const previous = rating;
    // The face moves at once; a failed save puts the old one back and says so.
    setRating(score === null ? null : { score, comment: comment === undefined ? (rating?.comment ?? null) : comment });
    startTransition(async () => {
      const result = await rateOutputAction({ output, score, ...(comment === undefined ? {} : { comment }) });
      if (!result.ok) {
        setRating(previous);
        setError(result.error);
        return;
      }
      setRating(result.rating);
      onChange?.(result.rating);
      if (!result.rating) {
        setNote("");
        setNoteOpen(false);
      }
    });
  }

  function close() {
    setOpen(false);
    setRefocus(true);
  }

  function pick(score: number) {
    close();
    save(rating?.score === score ? null : score);
  }

  const chosen = rating ? faceOf(rating.score) : null;
  // The face the group opens on: the chosen one, else the neutral middle.
  const focusIndex = rating ? rating.score - 1 : 2;

  return (
    <div className={cn("inline-flex flex-col", className)}>
      <div className="flex items-center gap-1">
        {prompt ? <span className="text-muted-foreground mr-1 text-xs">{prompt}</span> : null}
        <AnimatePresence initial={false} mode="popLayout">
          {open ? (
            <motion.div
              key="faces"
              role="radiogroup"
              aria-label={label}
              initial={{ opacity: 0, x: -4 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -4 }}
              transition={{ duration: 0.14 }}
              className="bg-muted/60 flex items-center gap-0.5 rounded-full px-1 py-0.5"
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  close();
                  return;
                }
                const step =
                  event.key === "ArrowRight" || event.key === "ArrowDown"
                    ? 1
                    : event.key === "ArrowLeft" || event.key === "ArrowUp"
                      ? -1
                      : 0;
                if (step === 0) return;
                event.preventDefault();
                const faces = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("[role=radio]")];
                const at = faces.indexOf(document.activeElement as HTMLButtonElement);
                faces[(at + step + faces.length) % faces.length]?.focus();
              }}
            >
              {RATING_FACES.map((entry, index) => (
                <motion.button
                  key={entry.score}
                  type="button"
                  role="radio"
                  aria-label={`${entry.score} of 5, ${entry.label}`}
                  aria-checked={rating?.score === entry.score}
                  tabIndex={index === focusIndex ? 0 : -1}
                  title={`${entry.score} of 5, ${entry.label}`}
                  disabled={pending}
                  autoFocus={index === focusIndex}
                  onClick={() => pick(entry.score)}
                  initial={{ scale: 0.6, opacity: 0 }}
                  animate={{ scale: 1, opacity: 1 }}
                  transition={{ type: "spring", stiffness: 520, damping: 26, delay: index * 0.025 }}
                  whileHover={{ scale: 1.15, y: -1 }}
                  whileTap={{ scale: 0.9 }}
                  className={cn(
                    "flex size-7 items-center justify-center rounded-full text-base leading-none outline-none grayscale-[35%] transition-[filter] hover:grayscale-0 focus-visible:ring-2 focus-visible:ring-ring",
                    rating?.score === entry.score && "bg-background grayscale-0 shadow-sm",
                  )}
                >
                  <span aria-hidden>{entry.face}</span>
                </motion.button>
              ))}
            </motion.div>
          ) : (
            <motion.button
              key="trigger"
              type="button"
              aria-label={chosen ? `Rated ${chosen.score} of 5, ${chosen.label}. Change rating` : label}
              aria-expanded={false}
              title={chosen ? `Rated ${chosen.score} of 5` : label}
              autoFocus={refocus}
              onClick={() => setOpen(true)}
              initial={{ scale: 0.8, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              transition={{ type: "spring", stiffness: 520, damping: 22 }}
              className={cn(
                "text-muted-foreground/70 hover:bg-muted hover:text-foreground flex size-7 items-center justify-center rounded-md outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
                chosen && "text-base leading-none",
              )}
            >
              {chosen ? <span aria-hidden>{chosen.face}</span> : <SmilePlus aria-hidden className="size-3.5" />}
            </motion.button>
          )}
        </AnimatePresence>
        {rating && !open && !noteOpen ? (
          <button
            type="button"
            onClick={() => setNoteOpen(true)}
            className="text-muted-foreground hover:text-foreground focus-visible:ring-ring rounded px-1 text-data outline-none focus-visible:ring-2"
          >
            {rating.comment ? "Edit note" : "Add a note"}
          </button>
        ) : null}
      </div>
      {rating && noteOpen ? (
        <form
          className="mt-1 flex items-center gap-1.5"
          onSubmit={(event) => {
            event.preventDefault();
            setNoteOpen(false);
            save(rating.score, note.trim() ? note.trim() : null);
          }}
        >
          <label htmlFor={noteId} className="sr-only">
            Why this rating
          </label>
          <input
            id={noteId}
            autoFocus
            value={note}
            maxLength={1000}
            onChange={(event) => setNote(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") setNoteOpen(false);
            }}
            placeholder="What made it this way? (optional)"
            className="border-border bg-background focus-visible:ring-ring h-7 w-72 max-w-full rounded-md border px-2 text-data outline-none focus-visible:ring-2"
          />
          <button
            type="submit"
            disabled={pending}
            className="hover:bg-muted focus-visible:ring-ring h-7 rounded-md px-2 text-data outline-none focus-visible:ring-2"
          >
            Save
          </button>
        </form>
      ) : null}
      {error ? (
        <p role="alert" className="text-destructive mt-0.5 text-xs">
          {error}
        </p>
      ) : null}
    </div>
  );
}
