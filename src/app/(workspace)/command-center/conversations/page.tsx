import Link from "next/link";
import { Suspense } from "react";
import { Empty, Panel, Screen, Status } from "@/components/workspace/ui";
import { listConversations } from "@/domains/conversations/queries";
import { getAuthContext } from "@/lib/auth";
import { ConversationForm } from "./conversation-form";

export const metadata = { title: "Conversations · Axiom" };

/*
 * Canonical conversations surface (ASH-140 D04): every thread renders from
 * Postgres, so a reload or another device sees the same list. Counts and
 * last activity are derived from the messages table at render.
 */

function when(date: Date | null): string {
  return date ? date.toISOString().slice(0, 16).replace("T", " ") + "Z" : "—";
}

async function Conversations() {
  const auth = await getAuthContext();
  const conversations = await listConversations(auth);

  return (
    <Screen
      title="Conversations"
      description="Durable threads with your agents. The timeline lives in Postgres, not the browser - reload and the same conversation is here."
    >
      <Panel title="Threads" description="Most recently active first.">
        <div className="divide-y divide-border">
          {conversations.map((conversation) => (
            <div key={conversation.id} className="flex flex-wrap items-center justify-between gap-3 py-3 first:pt-0">
              <div>
                <Link
                  href={`/command-center/conversations/${conversation.id}`}
                  className="text-[13px] font-medium underline-offset-4 hover:underline"
                >
                  {conversation.title || "Untitled conversation"}
                </Link>
                <p className="text-xs text-muted-foreground">
                  {conversation.profileName} · {conversation.messageCount} message{conversation.messageCount === 1 ? "" : "s"}
                  {conversation.subjectType ? ` · about ${conversation.subjectType}` : ""}
                </p>
              </div>
              <Status>active {when(conversation.lastMessageAt ?? conversation.updatedAt)}</Status>
            </div>
          ))}
        </div>
        {!conversations.length ? (
          <Empty title="No conversations yet" description="Start one below; it persists in Postgres from the first message." />
        ) : null}
      </Panel>

      <Panel title="Start a conversation" description="A title, an opening message, or both.">
        <ConversationForm />
      </Panel>
    </Screen>
  );
}

export default function ConversationsPage() {
  return (
    <Suspense fallback={<p role="status" className="p-6 text-[13px] text-muted-foreground">Loading conversations…</p>}>
      <Conversations />
    </Suspense>
  );
}
