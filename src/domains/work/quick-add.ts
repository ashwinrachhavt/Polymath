/*
 * Quick-add parsing: one line becomes a task. Tokens are removed from the
 * title and turned into fields:
 *   !low !medium !high !urgent (or !1..!4)   priority
 *   ~30m  ~2h  ~1h30m                        estimate
 *   #tag                                     tags
 *   today | tomorrow | mon..sun (as "due …") due date, 17:00 local
 * Pure and clock-injected so it is unit-testable; the caller supplies `now`.
 */

export type QuickAdd = {
  title: string;
  priority?: "low" | "medium" | "high" | "urgent";
  estimateMinutes?: number;
  tags: string[];
  dueAt?: Date;
};

const PRIORITIES: Record<string, QuickAdd["priority"]> = {
  low: "low", medium: "medium", med: "medium", high: "high", urgent: "urgent",
  "1": "low", "2": "medium", "3": "high", "4": "urgent",
};
const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

export function parseQuickAdd(input: string, now: Date = new Date()): QuickAdd {
  let text = ` ${input.trim()} `;
  const out: QuickAdd = { title: "", tags: [] };

  text = text.replace(/\s!(\w+)(?=\s)/g, (m, word: string) => {
    const priority = PRIORITIES[word.toLowerCase()];
    if (!priority) return m;
    out.priority = priority;
    return " ";
  });

  text = text.replace(/\s~(?:(\d+)h)?(?:(\d+)m?)?(?=\s)/gi, (m, h?: string, min?: string) => {
    const minutes = (h ? Number(h) * 60 : 0) + (min ? Number(min) : 0);
    if (!minutes || minutes > 24 * 60) return m;
    out.estimateMinutes = minutes;
    return " ";
  });

  text = text.replace(/\s#([\w-]+)(?=\s)/g, (_m, tag: string) => {
    const t = tag.toLowerCase();
    if (!out.tags.includes(t)) out.tags.push(t);
    return " ";
  });

  text = text.replace(/\sdue\s+(today|tomorrow|sun|mon|tue|wed|thu|fri|sat)[a-z]*(?=\s)/i, (_m, word: string) => {
    const due = new Date(now);
    due.setHours(17, 0, 0, 0);
    const w = word.toLowerCase();
    if (w === "tomorrow") due.setDate(due.getDate() + 1);
    else if (w !== "today") {
      const target = DAYS.indexOf(w.slice(0, 3));
      let ahead = (target - due.getDay() + 7) % 7;
      if (ahead === 0) ahead = 7;
      due.setDate(due.getDate() + ahead);
    }
    out.dueAt = due;
    return " ";
  });

  out.title = text.replace(/\s+/g, " ").trim();
  return out;
}
