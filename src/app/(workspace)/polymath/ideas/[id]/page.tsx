import Link from "next/link";
import { Suspense } from "react";
import { io } from "next/cache";
import { Empty, Panel, Screen } from "@/components/workspace/ui";
import { Skeleton } from "@/components/ui/skeleton";
import { getNote, type NoteContent } from "@/domains/knowledge/notes";
import { relatedNotes } from "@/domains/knowledge/relations";
import { IdeaEditor } from "@/components/polymath/zettels/idea-editor";
import { SuggestedLinksStrip } from "@/components/polymath/ideas/suggested-links-strip";
import { getAuthContext } from "@/lib/auth";

export const metadata = { title: "Idea · Polymath" };

/*
 * One idea. An accepted idea is an artifact of kind "zettel", so the detail is
 * the existing note read: no second query, no second store. The body is the
 * claim as a paragraph and the evidence as a blockquote - the shape
 * acceptZettel writes - so this page reads those two blocks apart rather than
 * rendering the whole body as one run of text.
 */

const BASE = "/polymath/ideas";
const stamp = (d: Date) => d.toLocaleDateString("en", { month: "short", day: "numeric" });

type Block = { text: string; quote: boolean };
type DocNode = { type?: string; text?: string; content?: unknown[] };

function textOf(node: unknown): string {
  if (!node || typeof node !== "object") return "";
  const { text, content } = node as DocNode;
  if (typeof text === "string") return text;
  return Array.isArray(content) ? content.map(textOf).join("") : "";
}

/** The body as blocks, so the claim and the quote can be told apart. Both the
 *  editor's doc JSON and a plain `{ text }` note render through here. */
function blocksOf(content: NoteContent | null): Block[] {
  const nodes = content && Array.isArray((content as DocNode).content) ? ((content as DocNode).content as DocNode[]) : [];
  if (nodes.length === 0) {
    const text = content && typeof content.text === "string" ? content.text : "";
    return text
      .split(/\n{2,}/)
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => ({ text: part.replace(/^>\s?/gm, ""), quote: part.startsWith(">") }));
  }
  return nodes
    .map((node) => ({ text: textOf(node).trim(), quote: node.type === "blockquote" }))
    .filter((block) => block.text.length > 0);
}

function MissingIdea() {
  return (
    <Screen title="Idea">
      <Empty
        title="This idea could not be found."
        description="It may have been removed, or it belongs to another workspace."
        action={
          <Link href={BASE} className="text-[13px] font-medium underline underline-offset-4">
            Back to Ideas
          </Link>
        }
      />
    </Screen>
  );
}

function Tags({ tags }: { tags: string[] }) {
  if (tags.length === 0) return null;
  return (
    <span className="flex flex-wrap gap-1">
      {tags.map((tag) => (
        <span key={tag} className="pill pill-neutral">
          {tag}
        </span>
      ))}
    </span>
  );
}

export async function IdeaDetailSurface({ params }: { params: Promise<{ id: string }> }) {
  await io();
  const { id } = await params;
  const auth = await getAuthContext();
  // A malformed, archived, foreign or missing id all read as null here, so
  // the miss is one friendly state rather than a thrown error or a stack.
  const idea = await getNote(auth, id);
  if (!idea) return <MissingIdea />;

  const related = await relatedNotes(auth, idea.id);
  const suggestions = related.filter((card) => !card.alreadyLinked).map((card) => ({ targetId: card.id, targetTitle: card.title }));
  // Blocks render in document order: the claim reads first, the evidence quote
  // sits under it, and a body someone wrote longer than one paragraph keeps
  // every paragraph instead of being truncated to the first.
  const blocks = blocksOf(idea.content);

  return (
    <Screen
      title={idea.title}
      actions={
        <Link href={BASE} className="text-[13px] text-muted-foreground underline-offset-2 hover:underline">
          Back to Ideas
        </Link>
      }
    >
      <Panel>
        <article className="mx-auto flex w-full max-w-[720px] flex-col gap-4">
          {blocks.map((block, index) =>
            block.quote ? (
              <blockquote
                key={index}
                className="border-l-2 border-border pl-3 text-[13px] leading-relaxed text-muted-foreground"
              >
                {block.text}
              </blockquote>
            ) : (
              <p key={index} className="text-[15px] leading-relaxed">
                {block.text}
              </p>
            ),
          )}
          <Tags tags={idea.tags} />
          <SuggestedLinksStrip artifactId={idea.id} suggestions={suggestions} />
          <p className="text-xs text-muted-foreground">
            Added {stamp(idea.createdAt)} · updated {stamp(idea.updatedAt)}
          </p>
          <details className="rounded-md border border-border px-3 py-2">
            <summary className="cursor-pointer text-[13px] font-medium">Edit this idea</summary>
            <div className="mt-2">
              <IdeaEditor
                workspaceId={auth.workspaceId}
                artifactId={idea.id}
                version={idea.version}
                initialContent={idea.draft?.content ?? idea.content ?? undefined}
                label={null}
              />
            </div>
          </details>
        </article>
      </Panel>
    </Screen>
  );
}

export default function IdeaDetailPage(props: { params: Promise<{ id: string }> }) {
  return (
    <Suspense
      fallback={
        <div role="status" aria-label="Loading idea" className="flex flex-1 flex-col gap-4 p-6">
          <Skeleton className="h-6 w-40" />
          <Skeleton className="h-40" />
        </div>
      }
    >
      <IdeaDetailSurface {...props} />
    </Suspense>
  );
}
