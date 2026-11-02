# Knowledge graph

What it is: the canvas at `/polymath/graph`, the canonical graph (ASH-167). Every note and zettel is a node. Explicit links render solid, machine suggestions dashed. Dragging between two cards ties them; selecting two or more combines them into one new zettel.

## Sub-features

- The full canvas: `GraphCanvas` over `listCardGraph`, all cards and edges.
- Local graph: `?focus=<card id>` narrows the canvas to one card and its direct neighbours.
- Editing from the canvas: drag to tie two cards, and the combine action that merges selected cards into a new zettel (server actions in `graph/actions.ts`).

## How to get to it (user POV)

The graph is not a rail entry. A note in the editor links to it, and the direct route is `/polymath/graph`.

## Driving it with agent-browser

1. Make sure at least one note exists first (the Notes journey creates one). An empty workspace renders an empty canvas, which proves rendering but not the graph.
2. Open `http://localhost:3000/polymath/graph`. Verify the known cards appear as nodes.
3. Open `http://localhost:3000/polymath/graph?focus=<note id>`. Verify only that node and its direct neighbours remain.
4. Capture the full and focused states to `/home/user/work/evidence/verify-polymath/`.

## Gotchas

- The canvas is client-rendered. Wait for hydration before asserting on nodes; the `waitSettled` pattern in `tests/e2e/helpers/settled.ts` exists for this class of flake.
- Drag-to-tie and combine mutate live rows through server actions. Decide deliberately whether a proof should mutate shared QA data, and delete seeded cards afterwards.
