import { redirect } from "next/navigation";
import type { RawSearchParams } from "@/lib/list-params";

// Notes moved to /alfred/notes in the IA simplification; this URL stays as the
// old-address bridge. A deep link carries ?id= to the exact note, so the one
// parameter the Notes surface reads is preserved; everything else drops.
export default function NotebookPage({ searchParams }: { searchParams: Promise<RawSearchParams> }) {
  return searchParams.then((raw) => {
    const id = typeof raw.id === "string" && raw.id ? raw.id : null;
    redirect(id ? `/alfred/notes?id=${encodeURIComponent(id)}` : "/alfred/notes");
  });
}
