import { redirect } from "next/navigation";

// Learning left the rail in the IA simplification; its decks live in Notes.
export default function LearningPage() {
  redirect("/alfred/notes");
}
