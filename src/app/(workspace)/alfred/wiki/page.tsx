import { redirect } from "next/navigation";

// Wiki left the rail in the IA simplification; its pages live in Knowledge.
export default function WikiPage() {
  redirect("/alfred/knowledge");
}
