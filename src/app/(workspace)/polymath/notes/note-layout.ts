/*
 * The geometry of one note's page, shared by the loaded NoteEditor and the
 * NotesSkeleton that streams in before it: the same top bar, reading column,
 * title line and body offset, so the title and the first line of text do not
 * move when the note arrives.
 *
 * Notion's page is the reference: a title of about 40px with no box around it,
 * a few lines of quiet metadata, then the text at a ~720px measure, centered.
 */
export const noteLayout = {
  /** The whole surface: the stack of panes fills the shell's content well. */
  screen: "h-full min-h-0",
  /** The quiet bar above the note. */
  bar: "flex h-12 items-center gap-1 px-3 md:px-5",
  /** The note's row beside its comments margin. */
  row: "flex min-w-0 items-start gap-6",
  cell: "min-w-0 flex-1",
  /** The centered reading column at the prose measure. */
  column: "mx-auto flex w-full max-w-[var(--measure-prose)] flex-col px-6 pb-24 pt-10 note-column max-sm:pt-6",
  /** The title's type: its line box is the title's height. */
  titleText: "text-[2.5rem] font-bold leading-[1.2] tracking-tight max-sm:text-[2rem]",
  meta: "mt-2 flex min-h-5 flex-wrap items-center gap-x-2 gap-y-1 text-data",
  /** Where the document starts. */
  body: "relative mt-8 flex flex-1 flex-col",
} as const;
