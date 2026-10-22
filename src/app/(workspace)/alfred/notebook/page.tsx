import { redirect } from "next/navigation";

// Notebook moved to Notes in the IA simplification; the dossier notebook is its home.
export default function NotebookPage() {
  redirect("/alfred/notes");
}
