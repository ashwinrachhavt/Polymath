import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { agentProfiles, messages, threads } from "@/domains/agents/schema";
import { artifactLinks, artifactVersions, artifacts, zettelProposals } from "@/domains/knowledge/schema";
import { makeTestDb, ownerAuth, seedWorkspace } from "../helpers/test-workspace";

/*
 * Task 20: zettelizing a thread or a selected run of messages. The thread
 * becomes a note-kind artifact through the same source edge syncThreadToGraph
 * uses; a second pass over the same thread reuses that artifact and proposes
 * nothing new — the thread's own earlier proposals dedupe first, then the
 * corpus.
 */

const handle = makeTestDb();
const suite = handle ? describe : describe.skip;
const holder: { db: ReturnType<typeof import("drizzle-orm/postgres-js").drizzle> | undefined } = { db: undefined };
vi.mock("@/lib/db", () => ({
  get db() {
    return holder.db;
  },
}));

vi.mock("@/integrations/zettels/extractor", () => ({
  defaultZettelExtractor: () => ({
    name: "fake",
    extract: async (text: string) => {
      const quote = "Rent is due on the first of each month.";
      const start = text.indexOf(quote);
      return start === -1
        ? []
        : [
            {
              title: "Rent timing",
              claim: "Rent is due on the first of each month.",
              quote,
              start,
              end: start + quote.length,
            },
          ];
    },
  }),
}));

beforeAll(() => {
  holder.db = handle?.db;
});
afterAll(async () => {
  await handle?.client.end();
});

/** A thread whose assistant reply carries the quote the fake extractor lifts. */
async function seedThread() {
  const db = holder.db!;
  const { userId, workspaceId } = await seedWorkspace(db, `tz-${Date.now()}`);
  const auth = ownerAuth(userId, workspaceId);
  const [profile] = await db
    .insert(agentProfiles)
    .values({ workspaceId, name: "Alfred" })
    .returning({ id: agentProfiles.id });
  const [thread] = await db
    .insert(threads)
    .values({ workspaceId, agentProfileId: profile.id, title: "Lease talk" })
    .returning({ id: threads.id });
  const [m1] = await db
    .insert(messages)
    .values({ workspaceId, threadId: thread.id, role: "user", content: "What about the lease? the first question" })
    .returning({ id: messages.id });
  const [m2] = await db
    .insert(messages)
    .values({
      workspaceId,
      threadId: thread.id,
      role: "assistant",
      content: "only this reply. Rent is due on the first of each month.",
    })
    .returning({ id: messages.id });
  return { auth, threadId: thread.id, m1: m1.id, m2: m2.id };
}

async function bodyOf(artifactId: string): Promise<string> {
  const db = holder.db!;
  const [artifact] = await db
    .select({ currentVersionId: artifacts.currentVersionId })
    .from(artifacts)
    .where(eq(artifacts.id, artifactId));
  const [version] = await db
    .select({ plainText: artifactVersions.plainText })
    .from(artifactVersions)
    .where(eq(artifactVersions.id, artifact.currentVersionId!));
  return version.plainText ?? "";
}

suite("thread zettelization (real Postgres)", () => {
  it("zettelizes only the selected messages' text", async () => {
    const { auth, threadId, m2 } = await seedThread();
    const { zettelizeThread } = await import("@/domains/knowledge/thread-zettels");

    const { artifactId } = await zettelizeThread(auth, { threadId, messageIds: [m2], idempotencyKey: "sel" });
    const body = await bodyOf(artifactId);
    expect(body).toContain("only this reply");
    expect(body).not.toContain("the first question");

    // Note-kind, reached through the thread's source edge — the same shape
    // syncThreadToGraph leaves behind.
    const [kind] = await holder
      .db!.select({ kind: artifacts.kind })
      .from(artifacts)
      .where(eq(artifacts.id, artifactId));
    expect(kind.kind).toBe("note");
    const [edge] = await holder
      .db!.select({ id: artifactLinks.id })
      .from(artifactLinks)
      .where(eq(artifactLinks.targetId, threadId));
    expect(edge).toBeDefined();
  });

  it("zettelizing a thread twice does not produce the same proposals twice over one thread", async () => {
    const { auth, threadId } = await seedThread();
    const { zettelizeThread } = await import("@/domains/knowledge/thread-zettels");

    const first = await zettelizeThread(auth, { threadId, idempotencyKey: "k1" });
    const second = await zettelizeThread(auth, { threadId, idempotencyKey: "k2" });
    expect(second.artifactId).toBe(first.artifactId);
    expect(second.proposed).toBe(0);
    expect(first.proposed).toBe(1);

    // The proposal rows back the count: one set, not two.
    const rows = await holder
      .db!.select({ id: zettelProposals.id })
      .from(zettelProposals)
      .where(eq(zettelProposals.sourceArtifactId, first.artifactId));
    expect(rows).toHaveLength(1);
  });
});
