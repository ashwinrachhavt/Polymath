import { redirect } from "next/navigation";

// Wiki left the rail in the IA simplification; its pages are artifacts and
// open from the Artifacts gallery (which has no wiki-only filter).
export default function WikiPage() {
  redirect("/artifacts");
}
