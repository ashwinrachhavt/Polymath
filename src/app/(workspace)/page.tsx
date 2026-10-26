import Link from "next/link";
import { EmptyState } from "@/components/empty-state";
import { Screen } from "@/components/workspace/ui";
import { listHomeQueue } from "@/domains/home/queue";
import { getAuthContext } from "@/lib/auth";
import { HomeQueue } from "./home-queue";

export const metadata = { title: "Decisions · Polymath" };

/*
 * ASH-309: the product's front door is the decision engine, not a place to
 * perform work. The root surface is one ranked queue of everything waiting
 * on the owner's judgment - agent proposals, capture classifications - each
 * card showing its exact effect, reason and risk, decided in one tap. Every
 * other surface is secondary; the Assistant conversation stays at /alfred.
 */
export default async function Home() {
  const auth = await getAuthContext();
  const cards = auth ? await listHomeQueue(auth.workspaceId) : [];
  return (
    <Screen title="Decisions" description="Everything waiting on your judgment, ranked by what expires, what it risks, and what is newest.">
      {cards.length === 0 ? (
        <EmptyState
          title="Nothing needs your decision."
          description="When an agent wants an outside effect or a capture reads as a task, note or contact, it waits here for your call."
          action={
            <Link className="text-[13px] underline underline-offset-2" href="/alfred">
              Ask Polymath for something
            </Link>
          }
        />
      ) : (
        <HomeQueue cards={cards} />
      )}
    </Screen>
  );
}
