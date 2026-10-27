import { io } from "next/cache";
import { getAuthContext } from "@/lib/auth";
import { WORK_PRIORITIES } from "@/domains/work/queries";
import { listWorkRowsForPage } from "./data";
import { ListToolbar } from "@/components/list/list-toolbar";
import { matchesQuery, parseListParams, type RawSearchParams } from "@/lib/list-params";
import { WorkBoard } from "./work-board";

/*
 * The Work board on Neon: the same canonical rows as the list, grouped into
 * status lanes. A lane move is a status patch - the lane a card lands in is
 * the field - so the board never disagrees with the list about a task's state.
 */
export async function NeonBoard({ raw = {} }: { raw?: RawSearchParams }) {
  await io();
  const auth = await getAuthContext();
  const list = parseListParams(raw, { filters: { priority: WORK_PRIORITIES } });
  const filtered = Boolean(list.q || list.filters.priority);
  const keep = (row: { priority: string; title: string }) =>
    (!list.filters.priority || row.priority === list.filters.priority) && matchesQuery(list.q, row.title);

  const [openRows, doneRows] = await Promise.all([
    listWorkRowsForPage(auth, "open"),
    listWorkRowsForPage(auth, "done", 20),
  ]);
  const cards = [...openRows, ...doneRows].filter(keep).map((row) => ({
    id: row.id,
    title: row.title,
    status: row.status,
    priority: row.priority,
    dueAt: row.dueAt ? row.dueAt.toISOString() : null,
    version: row.version,
    subtaskCount: row.subtaskCount,
    subtasksDone: row.subtasksDone,
    blockedBy: row.blockedBy,
  }));

  return (
    <div className="p-4 md:p-6">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-x-6 gap-y-2">
        <h1 className="text-[15px] font-medium">Board</h1>
      </div>
      <div className="mb-4">
        <ListToolbar
          searchPlaceholder="Search tasks"
          filters={[
            { key: "priority", label: "Priority", allLabel: "Any priority", options: WORK_PRIORITIES.map((v) => ({ value: v, label: v[0]!.toUpperCase() + v.slice(1) })) },
          ]}
          total={filtered ? cards.length : undefined}
          noun={cards.length === 1 ? "task" : "tasks"}
        />
      </div>
      <WorkBoard cards={cards} detailBase="/neuralflow/work" />
    </div>
  );
}
