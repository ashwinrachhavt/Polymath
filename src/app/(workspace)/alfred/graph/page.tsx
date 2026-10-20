import { connection } from "next/server";
import { Empty, Screen } from "@/components/workspace/ui";
import { listCardGraph } from "@/domains/knowledge/relations";
import { getAuthContext } from "@/lib/auth";
import { GraphCanvas } from "./graph-canvas";

export const metadata = { title: "Graph · Polymath" };

/*
 * The canonical graph (ASH-167): every note and zettel as a node, explicit
 * links solid, machine suggestions dashed. Drag between two cards to tie
 * them; select two or more and combine them into one new zettel.
 */
export default async function AlfredGraphPage() {
  await connection();
  const auth = await getAuthContext();
  const { nodes, edges } = await listCardGraph(auth);
  return (
    <Screen title="Graph" description="Tie ideas together. Drag from one card to another to link them, or select several and combine them into a new zettel.">
      {nodes.length === 0 ? (
        <Empty title="No cards yet" description="Write a note or a zettel and it appears here, linked to what it resembles." />
      ) : (
        <GraphCanvas nodes={nodes} edges={edges} />
      )}
    </Screen>
  );
}
