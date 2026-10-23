import { redirect } from "next/navigation";

// Opportunities left the rail in the IA simplification; its people live in Relationships.
export default function OpportunitiesPage() {
  redirect("/command-center/relationships/people");
}
