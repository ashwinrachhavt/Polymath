import { redirect } from "next/navigation";

// Notes moved to /alfred/notes in the IA simplification; this URL stays as the
// old-address bridge.
export default function NotebookPage() {
  redirect("/alfred/notes");
}
