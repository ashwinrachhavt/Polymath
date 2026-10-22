import { redirect } from "next/navigation";

// Sources left the rail in the IA simplification; the library lives in Dossiers.
export default function SourcesPage() {
  redirect("/alfred/dossiers");
}
