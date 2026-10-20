import { redirect } from "next/navigation";

/*
 * The Assistant is home: the product's first move is a conversation, not a
 * browse. Today is one click away and still the day's decision surface — the
 * briefing did not stop mattering, it stopped being the front door.
 */
export default function Home() {
  redirect("/alfred");
}
