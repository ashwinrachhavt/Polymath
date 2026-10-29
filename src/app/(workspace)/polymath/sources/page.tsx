import { redirect } from "next/navigation";

// Sources left the rail in the IA simplification; the library lives in Notebook.
export default function SourcesPage() {
  redirect("/polymath/dossiers");
}
