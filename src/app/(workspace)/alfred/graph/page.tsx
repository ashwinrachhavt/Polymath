import Link from "next/link";
import { Button } from "@/components/ui/button";
import { PageHeader, Section } from "@/components/page-header";
import { Empty } from "@/components/workspace/ui";

export const metadata = { title: "Graph · Axiom" };

/*
 * /alfred/graph has no canonical page yet - the graph is still a
 * browser-preview tool. It used to fall through to a bare 404 outside the
 * shell; this page keeps the shell and points at the preview surface until
 * the canonical graph lands (ASH-167).
 */
export default function AlfredGraphPage() {
  return (
    <>
      <PageHeader title="Graph" purpose="Connect your thinking." />
      <div className="page-content"><Section title="Preview tool" description="Explicit links between your artifacts, not an inferred semantic map.">
        <Empty
          title="The graph lives in the preview tools for now"
          description="The canonical graph page has not landed yet. The preview version explores the same explicit artifact links and is marked as a preview."
          action={
            <Button variant="outline" asChild>
              <Link href="/apps/alfred/graph">Open the graph preview</Link>
            </Button>
          }
        />
      </Section></div>
    </>
  );
}
