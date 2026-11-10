/*
 * The geometry of one note's page, shared by the loaded NoteEditor and the
 * NotesSkeleton that streams in before it: the same screen padding, rows,
 * reading column, header height, title line and body offset, so the title and
 * the first line of text do not move when the note arrives.
 */
export const noteLayout = {
  /** The scrolling screen inside the shell's content well. */
  screen: "suite-screen h-full overflow-y-auto",
  /** NotebookWorkspace's row, and the editor's row beside its comments margin. */
  row: "flex min-w-0 flex-1 items-start gap-6",
  cell: "min-w-0 flex-1",
  /** The centered reading column at the prose measure. */
  column:
    "mx-auto flex min-h-[var(--canvas-min)] w-full max-w-[var(--measure-prose)] flex-col px-6 pb-24 pt-12 note-column",
  /** The header row of icon actions above the title. */
  header: "-mx-6 flex h-8 items-center justify-end px-6",
  titleRow: "flex items-start gap-2",
  /** The title's type: its line box is the title's height. */
  titleText: "text-display font-semibold leading-[1.2] tracking-tight",
  meta: "mt-3 flex min-h-5 flex-wrap items-center gap-2 text-data",
  actions: "mt-4 flex flex-wrap items-center gap-2",
  /** Where the document starts. */
  body: "relative mt-8 flex flex-1 flex-col",
} as const;
