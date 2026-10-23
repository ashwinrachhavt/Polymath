import { redirect } from "next/navigation";

// Focus left the rail in the IA simplification; sessions live in Work.
export default function FocusPage() {
  redirect("/neuralflow/work");
}
