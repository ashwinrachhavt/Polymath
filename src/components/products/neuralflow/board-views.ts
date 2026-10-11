import { z } from "zod";

const viewSchema = z.object({ id: z.string(), title: z.string(), project: z.string(), query: z.string() });
export type BoardView = z.infer<typeof viewSchema>;
export const defaultBoardViews: BoardView[] = [
  { id: "all", title: "All commitments", project: "all", query: "" },
  { id: "deep", title: "Deep work", project: "all", query: "Deep work" },
];

type ViewStorage = Pick<Storage, "getItem" | "setItem">;

export function createBoardViewStore(scope: string, storage?: ViewStorage) {
  // Do not migrate the legacy unscoped key: its records have no trustworthy owner.
  const key = `axiom-neuralflow-board-views-v2:${scope}`;
  let views = defaultBoardViews;
  let lastRaw: string | null | undefined;
  let readNotice = "";
  let writeNotice = "";
  const listeners = new Set<() => void>();
  const resolveStorage = () => storage || window.localStorage;
  function getSnapshot() {
    if (storage || typeof window !== "undefined") {
      try {
        const raw = resolveStorage().getItem(key);
        if (raw !== lastRaw) {
          lastRaw = raw;
          if (raw) {
            const parsed = z.array(viewSchema).safeParse(JSON.parse(raw));
            if (parsed.success) {
              views = [...defaultBoardViews, ...parsed.data.filter((view) => !defaultBoardViews.some((sample) => sample.id === view.id))];
              readNotice = "";
            } else {
              views = defaultBoardViews;
              readNotice = "Saved board views have an incompatible format. Default views were loaded.";
            }
          } else {
            views = defaultBoardViews;
            readNotice = "";
          }
        }
      } catch {
        readNotice = "Saved board views could not be loaded. New views may last only in this tab.";
      }
    }
    return views;
  }
  function publish() { listeners.forEach((listener) => listener()); }
  function onStorage(event: StorageEvent) { if (event.key === key || event.key === null) publish(); }
  function subscribe(listener: () => void) {
    if (!listeners.size && !storage && typeof window !== "undefined") window.addEventListener("storage", onStorage);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
      if (!listeners.size && !storage && typeof window !== "undefined") window.removeEventListener("storage", onStorage);
    };
  }
  function addView(view: BoardView) {
    // Re-read before writing: another same-owner tab may have saved since our render.
    const latest = getSnapshot();
    if (latest.some((existing) => existing.id === view.id)) return;
    views = [...latest, view];
    try {
      const raw = JSON.stringify(views);
      resolveStorage().setItem(key, raw);
      lastRaw = raw;
      writeNotice = "";
    } catch { writeNotice = "Saved view is available in this tab, but browser storage could not save it."; }
    publish();
  }
  return { getSnapshot, subscribe, addView, getNotice: () => writeNotice || readNotice };
}
