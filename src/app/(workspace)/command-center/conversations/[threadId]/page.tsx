import { connection } from "next/server";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { Empty, Panel, Screen, Status } from "@/components/workspace/ui";
import { getConversation } from "@/domains/conversations/queries";
import { getAuthContext } from "@/lib/auth";

export const metadata = { title: "Conversation · Axiom" };

/* One thread's message timeline, read from Postgres at render (ASH-140 D04).
 * Replay, cancel and checkpoints land in later slices. */

async function Timeline({ threadId }: { threadId: string }) {
  await connection();
  const auth = await getAuthContext();
  const conversation = await getConversation(auth, threadId);
  if (!conversation) notFound();

  return (
    <Screen
      title={conversation.thread.title || "Untitled conversation"}
      description={`With ${conversation.thread.profileName} · started ${conversation.thread.createdAt.toISOString().slice(0, 16).replace("T", " ")}Z`}
    >
      <p className="text-[13px]">
        <Link href="/command-center/conversations" className="text-muted-foreground underline-offset-4 hover:underline">
          ← All conversations
        </Link>
      </p>
      <Panel title="Timeline" description={`${conversation.entries.length} message${conversation.entries.length === 1 ? "" : "s"}.`}>
        <div className="divide-y divide-border">
          {conversation.entries.map((entry) => (
            <div key={entry.id} className="py-3 first:pt-0">
              <div className="mb-1 flex items-center gap-2">
                <Status>{entry.role}</Status>
                <span className="text-xs text-muted-foreground">
                  {entry.createdAt.toISOString().slice(0, 16).replace("T", " ")}Z
                </span>
              </div>
              <p className="whitespace-pre-wrap text-[13px]">{entry.content ?? ""}</p>
            </div>
          ))}
        </div>
        {!conversation.entries.length ? (
          <Empty title="No messages yet" description="The thread is saved; its first message will appear here." />
        ) : null}
      </Panel>
    </Screen>
  );
}

export default async function ConversationPage({ params }: { params: Promise<{ threadId: string }> }) {
  const { threadId } = await params;
  return (
    <Suspense fallback={<p role="status" className="p-6 text-[13px] text-muted-foreground">Loading conversation…</p>}>
      <Timeline threadId={threadId} />
    </Suspense>
  );
}
