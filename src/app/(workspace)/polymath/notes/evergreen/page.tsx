import { redirect } from "next/navigation";
import type { RawSearchParams } from "@/lib/list-params";

// The stacked reader is now what /polymath/notes opens to; keep old links working.
export default async function EvergreenNotesPage({ searchParams }: { searchParams: Promise<RawSearchParams> }) {
  const raw = await searchParams;
  const params = new URLSearchParams();
  if (typeof raw.stack === "string") params.set("stack", raw.stack);
  if (raw.board === "1") params.set("board", "1");
  const query = params.toString();
  redirect(query ? `/polymath/notes?${query}` : "/polymath/notes");
}
