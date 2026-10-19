import { connection } from "next/server";
import Link from "next/link";
import { Suspense } from "react";
import { Panel, Screen, Status } from "@/components/workspace/ui";
import { redirectPastEnd } from "@/components/list/clamp";
import { ListToolbar } from "@/components/list/list-toolbar";
import { NoResults } from "@/components/list/no-results";
import { Pagination } from "@/components/list/pagination";
import { listConversationProfiles, pageConversations } from "@/domains/conversations/queries";
import { listHref, offsetFor, parseListParams, type RawSearchParams } from "@/lib/list-params";
import { getAuthContext } from "@/lib/auth";
import { ConversationForm } from "./conversation-form";

export const metadata = { title: "Conversations · Polymath" };

/*
 * Canonical conversations surface (ASH-140 D04): every thread renders from
 * Postgres, so a reload or another device sees the same list. Counts and
 * last activity are derived from the messages table at render.
 */

function when(date: Date | null): string {
  return date ? date.toISOString().slice(0, 16).replace("T", " ") + "Z" : "—";
}

const BASE = "/command-center/conversations";

async function Conversations({ searchParams }: { searchParams: Promise<RawSearchParams> }) {
  const raw = await searchParams;
  await connection();
  const auth = await getAuthContext();
  const profiles = await listConversationProfiles(auth);
  const list = parseListParams(raw, { filters: { agent: profiles } });
  const found = await pageConversations(auth, {
    query: list.q,
    profile: list.filters.agent,
    limit: list.pageSize,
    offset: offsetFor(list.page, list.pageSize),
  });
  redirectPastEnd(BASE, raw, list.page, list.pageSize, found.total);
  const conversations = found.items;

  return (
    <Screen
      title="Conversations"
      description="Durable threads with your agents. The timeline lives in Postgres, not the browser - reload and the same conversation is here."
    >
      <ListToolbar
        searchPlaceholder="Search thread titles"
        filters={[
          { key: "agent", label: "Agent", allLabel: "All agents", options: profiles.map((p) => ({ value: p, label: p })) },
        ]}
        total={found.total}
        noun={found.total === 1 ? "thread" : "threads"}
      />
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
          <NoResults
            filtered={Boolean(list.q || list.filters.agent)}
            clearHref={listHref(BASE, raw, { q: undefined, agent: undefined, page: undefined })}
            emptyTitle="No conversations yet"
            emptyDescription="Start one below; it persists in Postgres from the first message."
          />
        ) : null}
        <Pagination basePath={BASE} raw={raw} page={list.page} pageSize={list.pageSize} total={found.total} />
      </Panel>

      <Panel title="Start a conversation" description="A title, an opening message, or both.">
        <ConversationForm />
      </Panel>
    </Screen>
  );
}

export default function ConversationsPage({ searchParams }: { searchParams: Promise<RawSearchParams> }) {
  return (
    <Suspense fallback={<p role="status" className="p-6 text-[13px] text-muted-foreground">Loading conversations…</p>}>
      <Conversations searchParams={searchParams} />
    </Suspense>
  );
}
