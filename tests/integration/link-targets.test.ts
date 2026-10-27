import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { captures } from "@/domains/capture/schema";
import { tasks } from "@/domains/work/schema";
import { makeTestDb, ownerAuth, seedWorkspace } from "../helpers/test-workspace";

/*
 * Row 36: the note editor's [[ ]] link picker must resolve beyond knowledge
 * artifacts - captures and tasks are linkable targets too. These cover the
 * read side the picker action composes: tenant scoping, archived exclusion,
 * display labels, and the canonical routes the inserted links resolve to
 * (a deleted target lands on the destination page's empty-selection state).
 */

const handle = makeTestDb();
const suite = handle ? describe : describe.skip;
let db: NonNullable<typeof handle>["db"];
let captureQueries: typeof import("@/domains/capture/queries");
let workQueries: typeof import("@/domains/work/queries");

beforeAll(async () => {
  if (!handle) return;
  ({ db } = handle);
  captureQueries = await import("@/domains/capture/queries");
  workQueries = await import("@/domains/work/queries");
});

afterAll(async () => {
  await handle?.client.end();
});

async function seed(slug: string) {
  const { userId, workspaceId } = await seedWorkspace(db, `${slug}-${Date.now()}`);
  return { auth: ownerAuth(userId, workspaceId), workspaceId };
}

suite("link-target search", () => {
  it("matches captures and tasks in the workspace with canonical hrefs, never the neighbor's", async () => {
    const { auth, workspaceId } = await seed("lt-main");
    const other = await seed("lt-other");
    await db.insert(captures).values({ workspaceId, kind: "text", captureMode: "authored", rawPayload: { text: "Call the accountant about Q3" }, text: "Call the accountant about Q3" });
    await db.insert(captures).values({ workspaceId: other.workspaceId, kind: "text", captureMode: "authored", rawPayload: { text: "Call the accountant about Q3" }, text: "Call the accountant about Q3" });
    await db.insert(tasks).values({ workspaceId, title: "Accountant follow-up" });
    await db.insert(tasks).values({ workspaceId: other.workspaceId, title: "Accountant follow-up" });

    const caps = await captureQueries.searchCapturesForLink(auth, "accountant");
    expect(caps).toHaveLength(1);
    expect(caps[0].kind).toBe("capture");
    expect(caps[0].title).toBe("Call the accountant about Q3");
    expect(caps[0].href).toBe(`/command-center/inbox?id=${caps[0].id}`);

    const tks = await workQueries.searchTasksForLink(auth, "accountant");
    expect(tks).toHaveLength(1);
    expect(tks[0].kind).toBe("task");
    expect(tks[0].title).toBe("Accountant follow-up");
    expect(tks[0].href).toBe(`/neuralflow/work?task=${tks[0].id}`);
  });

  it("excludes archived captures and archived tasks", async () => {
    const { auth, workspaceId } = await seed("lt-arch");
    const [cap] = await db.insert(captures).values({ workspaceId, kind: "text", captureMode: "authored", rawPayload: { text: "archived accountant note" }, text: "archived accountant note" }).returning();
    const [task] = await db.insert(tasks).values({ workspaceId, title: "archived accountant task" }).returning();
    await db.update(captures).set({ archivedAt: new Date() }).where(eq(captures.id, cap.id));
    await db.update(tasks).set({ archivedAt: new Date() }).where(eq(tasks.id, task.id));

    expect(await captureQueries.searchCapturesForLink(auth, "accountant")).toHaveLength(0);
    expect(await workQueries.searchTasksForLink(auth, "accountant")).toHaveLength(0);
  });

  it("labels a url capture by host and truncates long text", async () => {
    expect(captureQueries.captureLinkLabel({ text: null, url: "https://example.com/spec" })).toBe("example.com");
    expect(captureQueries.captureLinkLabel({ text: null, url: "not a url" })).toBe("not a url");
    expect(captureQueries.captureLinkLabel({ text: null, url: null })).toBe("Untitled capture");
    const long = `  \n${"x".repeat(80)}`;
    const label = captureQueries.captureLinkLabel({ text: long, url: null });
    expect(label).toHaveLength(60);
    expect(label.endsWith("...")).toBe(true);
  });
});
