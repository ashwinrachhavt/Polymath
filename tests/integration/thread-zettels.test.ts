import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { agentProfiles, messages, threads } from "@/domains/agents/schema";
import { artifactLinks, artifactVersions, artifacts, zettelProposals } from "@/domains/knowledge/schema";
import { makeTestDb, ownerAuth, seedWorkspace } from "../helpers/test-workspace";

/*
 * Task 20: zettelizing a thread or a selected run of messages. The thread
 * becomes a note-kind artifact through the same source edge syncThreadToGraph
 * uses; a second pass over the same thread reuses that artifact and proposes
 * nothing new: its candidates are deduped against the thread's own earlier
 * proposals for the artifact (pending and accepted) by claim/quote overlap —
 * the span-key index alone misses a re-chunked region — and the accepted
 * corpus flags whatever survives.
 */

const handle = makeTestDb();
const suite = handle ? describe : describe.skip;
const holder: { db: ReturnType<typeof import("drizzle-orm/postgres-js").drizzle> | undefined } = { db: undefined };
vi.mock("@/lib/db", () => ({
  get db() {
    return holder.db;
  },
}));

// The stubbed embedding provider returns one unit vector per distinct string
// on a deterministic axis: identical claims land on the same axis (cosine
// distance 0 — a duplicate), different claims are orthogonal (distance 1 —
// not). No network, and the real cosine path still runs.
vi.mock("@/integrations/embeddings/provider", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/integrations/embeddings/provider")>();
  const dims = actual.EMBEDDING_DIMENSIONS;
  const axisOf = (text: string) => {
    let hash = 2166136261;
    for (let i = 0; i < text.length; i += 1) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0) % dims;
  };
  return {
    ...actual,
    embeddingProvider: () => ({
      model: "test-embed",
      embed: async (values: string[]) =>
        values.map((text) => {
          const vector = Array.from({ length: dims }, () => 0);
          vector[axisOf(text)] = 1;
          return vector;
        }),
    }),
  };
});

type FakeCandidate = { title: string; claim: string; quote: string };

const FULL_QUOTE = "Rent is due on the first of each month.";
/** Overlaps the first quote's region without containing it — the containment check cannot fire on it. */
const SHIFTED_WINDOW = "of each month. The deposit is protected until move out.";

/** The deterministic extractor the file's earlier tests rely on: the full sentence, every pass. */
function deterministicExtract(text: string): FakeCandidate[] {
  return text.includes(FULL_QUOTE) ? [{ title: "Rent timing", claim: FULL_QUOTE, quote: FULL_QUOTE }] : [];
}

/** What the mocked extractor does on the next pass; tests reassign between zettelize calls. */
const extractorBehavior: { run: (text: string) => FakeCandidate[] } = { run: deterministicExtract };

vi.mock("@/integrations/zettels/extractor", () => ({
  defaultZettelExtractor: () => ({
    name: "fake",
    extract: async (text: string) => extractorBehavior.run(text),
  }),
}));

beforeAll(() => {
  holder.db = handle?.db;
});
beforeEach(() => {
  extractorBehavior.run = deterministicExtract;
});
afterAll(async () => {
  await handle?.client.end();
});

/** A thread whose assistant reply carries the quote the fake extractor lifts. */
async function seedThread(reply = "only this reply. Rent is due on the first of each month.") {
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
    .values({ workspaceId, threadId: thread.id, role: "assistant", content: reply })
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

async function proposalRows(artifactId: string) {
  return holder
    .db!.select({ id: zettelProposals.id, spanStart: zettelProposals.spanStart, spanEnd: zettelProposals.spanEnd })
    .from(zettelProposals)
    .where(eq(zettelProposals.sourceArtifactId, artifactId));
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
    const rows = await proposalRows(first.artifactId);
    expect(rows).toHaveLength(1);
  });

  // The live defect (dogfood runs 6c2533d9/4a2ef2c3): pass 1 proposed a row on
  // span 405-666; pass 2 over the UNCHANGED thread re-chunked the same region
  // into spans 405-626 and 627-666 — different dedupe keys, so the span index
  // let two near-duplicates insert. A deterministic stub cannot reproduce it;
  // this stub re-chunks on purpose, the way a live extractor does.
  it("a second pass whose extractor re-chunks the same region proposes nothing new", async () => {
    const { auth, threadId } = await seedThread(
      "only this reply. The lease has many clauses. Rent is due on the first of each month. The deposit is protected until move out.",
    );
    const { zettelizeThread } = await import("@/domains/knowledge/thread-zettels");

    const first = await zettelizeThread(auth, { threadId, idempotencyKey: "chunk-1" });
    expect(first.proposed).toBe(1);

    // Pass 2 reads the same artifact text but re-chunks: two sub-spans of the
    // first quote (one with re-worded claims — quote overlap is what catches
    // them), and a shifted window whose containment check cannot fire but
    // whose claim is unchanged (the embedding distance is what catches it).
    extractorBehavior.run = (text) => {
      const subStart = text.indexOf("Rent is due on the first");
      const windowStart = text.indexOf(SHIFTED_WINDOW);
      if (subStart === -1 || windowStart === -1)
        throw new Error("re-chunk stub: anchors missing from the artifact text");
      return [
        {
          title: "Rent timing reworded",
          claim: "The first of each month is when rent is due.",
          quote: "Rent is due on the first",
        },
        { title: "Rent day", claim: "Rent must be paid by the first day of the month.", quote: "of each month." },
        {
          title: "Rent timing",
          claim: FULL_QUOTE,
          quote: text.slice(windowStart, windowStart + SHIFTED_WINDOW.length),
        },
      ];
    };
    const second = await zettelizeThread(auth, { threadId, idempotencyKey: "chunk-2" });
    expect(second.artifactId).toBe(first.artifactId);
    expect(second.proposed).toBe(0);

    // The pass-1 row stands alone: no re-chunked near-duplicates landed.
    const rows = await proposalRows(first.artifactId);
    expect(rows).toHaveLength(1);
  });

  it("a genuinely new claim on a second pass still proposes", async () => {
    const { auth, threadId } = await seedThread(
      "only this reply. The lease has many clauses. Rent is due on the first of each month. The deposit is protected until move out.",
    );
    const { zettelizeThread } = await import("@/domains/knowledge/thread-zettels");

    const first = await zettelizeThread(auth, { threadId, idempotencyKey: "new-1" });
    expect(first.proposed).toBe(1);

    // A different region with a different claim overlaps nothing — the dedupe
    // must suppress repeats, not the conversation's unread material.
    extractorBehavior.run = () => [
      {
        title: "Deposit protection",
        claim: "The deposit stays protected until the tenant moves out.",
        quote: "The deposit is protected until move out.",
      },
    ];
    const second = await zettelizeThread(auth, { threadId, idempotencyKey: "new-2" });
    expect(second.proposed).toBe(1);

    const rows = await proposalRows(second.artifactId);
    expect(rows).toHaveLength(2);
  });
});
