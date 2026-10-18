import Link from "next/link";
import { Suspense } from "react";
import { FocusScreen } from "@/components/products/neuralflow/focus-screen";
import { NeuralFlowFeatureLinks } from "../work/work-today";

export const metadata = { title: "Focus · Axiom" };

type FocusQuery = Promise<Record<string, string | string[] | undefined>>;

async function FocusSession({ searchParams }: { searchParams: FocusQuery }) {
  const query = await searchParams;
  const task = typeof query.task === "string" ? query.task : undefined;
  return <FocusScreen key={task || "active"} initialTask={task} />;
}

export default function FocusPage({ searchParams }: { searchParams: FocusQuery }) {
  return (
    <>
      <div className="flex flex-col gap-2 border-b border-border px-4 py-3 md:px-6">
        <Link href="/neuralflow/work" className="w-fit py-1 text-[13px] font-medium hover:underline">Back to Work</Link>
        <NeuralFlowFeatureLinks />
      </div>
      <Suspense fallback={<p role="status" className="p-6 text-[13px] text-muted-foreground">Opening focus session…</p>}><FocusSession searchParams={searchParams} /></Suspense>
    </>
  );
}
