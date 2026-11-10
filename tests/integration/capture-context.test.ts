import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { captures } from "@/domains/capture/schema";
import { readCaptureContext } from "@/domains/capture/context";
import { projects } from "@/domains/work/schema";
import { makeTestDb, ownerAuth, seedWorkspace } from "../helpers/test-workspace";

/*
 * Decision-free capture: the words plus whatever context arrived, stored
 * beside the original. A suggested project is kept only when it is the
 * workspace's own, with the title read from the row, never from the client.
 */

const handle = makeTestDb();
const suite = handle ? describe : describe.skip;
let db: NonNullable<typeof handle>["db"];
let commands: typeof import("@/domains/capture/commands");

beforeAll(async () => {
  if (!handle) return;
  ({ db } = handle);
  commands = await import("@/domains/capture/commands");
});

afterAll(async () => {
  await handle?.client.end();
});

async function seed(slug: string) {
  const { userId, workspaceId } = await seedWorkspace(db, `${slug}-${Date.now()}`);
  return ownerAuth(userId, workspaceId);
}

async function project(workspaceId: string, name: string) {
  const [row] = await db.insert(projects).values({ workspaceId, name }).returning({ id: projects.id });
  return row.id;
}

suite("capture context", () => {
  it("captures with no context at all, exactly as before", async () => {
    const auth = await seed("ctx-none");
    const capture = await commands.createCapture(auth, { text: "a bare thought" });
    expect(readCaptureContext(capture.rawPayload)).toBeNull();
    expect(capture.rawPayload).toEqual({ text: "a bare thought" });
  });

  it("keeps the passage, its surroundings, an unknown why, and a resolved project", async () => {
    const auth = await seed("ctx-full");
    const projectId = await project(auth.workspaceId, "Evergreen notes");
    const capture = await commands.createCapture(auth, {
      text: "Notes should be atomic",
      context: {
        capturedAt: "2026-11-09T10:00:00.000Z",
        source: { kind: "web", title: "Evergreen notes", url: "https://example.com/notes", version: "rev 3" },
        passage: "Notes should be atomic",
        surrounding: { before: "The first principle:", after: "and concept-oriented." },
        turn: { messageId: "m1", role: "assistant" },
        partial: { reason: "Only the first page was kept." },
        why: { kind: "unknown" },
        suggestion: { projectId, projectTitle: "a title the client made up", question: "How small is a note?" },
      },
    });
    const [row] = await db.select().from(captures).where(eq(captures.id, capture.id));
    const context = readCaptureContext(row.rawPayload);
    expect(context).toMatchObject({
      passage: "Notes should be atomic",
      surrounding: { before: "The first principle:", after: "and concept-oriented." },
      source: { version: "rev 3" },
      partial: { reason: "Only the first page was kept." },
      why: { kind: "unknown" },
      suggestion: { projectId, projectTitle: "Evergreen notes", question: "How small is a note?" },
    });
    // The words are still the original, untouched by the context.
    expect(row.text).toBe("Notes should be atomic");
  });

  it("drops a suggested project from another workspace", async () => {
    const mine = await seed("ctx-mine");
    const theirs = await seed("ctx-theirs");
    const foreign = await project(theirs.workspaceId, "Not yours");
    const capture = await commands.createCapture(mine, {
      text: "keep this",
      context: {
        why: { kind: "answer", text: "it answers my question", via: "text" },
        suggestion: { projectId: foreign },
      },
    });
    const context = readCaptureContext(capture.rawPayload);
    expect(context?.suggestion).toBeUndefined();
    expect(context?.why).toEqual({ kind: "answer", text: "it answers my question", via: "text" });
  });
});
