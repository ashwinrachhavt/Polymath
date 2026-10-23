import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { auditEvents } from "@/domains/audit/schema";
import { artifacts, artifactVersions } from "@/domains/knowledge/schema";
import { captures } from "@/domains/capture/schema";
import { makeTestDb, ownerAuth, seedWorkspace } from "../helpers/test-workspace";

/*
 * "Turn it into anything" conversion invariants, on a real database: the
 * draft artifact, the capture's lineage edge (convertedType draft:<template>,
 * convertedId) and the audit rows commit together; a second conversion is a
 * conflict; a stale version is a stale write; another workspace's capture is
 * invisible, never an error oracle.
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

suite("capture to draft", () => {
  it("converts a text capture into a memo email draft with lineage + audit in one commit", async () => {
    const auth = await seed("draft-email");
    const capture = await commands.createCapture(auth, { text: "Ask Dana for the Q3 pricing sign-off" });

    const { capture: converted, draft } = await commands.convertCaptureToDraft(auth, {
      captureId: capture.id,
      expectedVersion: capture.version,
      template: "email",
    });

    expect(converted.processingState).toBe("converted");
    expect(converted.convertedType).toBe("draft:email");
    expect(converted.convertedId).toBe(draft.id);

    const [artifact] = await db.select().from(artifacts).where(and(eq(artifacts.workspaceId, auth.workspaceId), eq(artifacts.id, draft.id)));
    expect(artifact.kind).toBe("note");
    expect(artifact.title).toBe("Email draft: Ask Dana for the Q3 pricing sign-off");

    const [version] = await db.select().from(artifactVersions).where(eq(artifactVersions.id, artifact.currentVersionId!));
    expect(version.plainText).toContain("**Subject:** Ask Dana for the Q3 pricing sign-off");
    expect(version.plainText).toContain("> Ask Dana for the Q3 pricing sign-off");

    const audits = await db.select().from(auditEvents).where(eq(auditEvents.workspaceId, auth.workspaceId));
    expect(audits.some((a) => a.subjectId === capture.id && a.action === "capture.converted")).toBe(true);
    expect(audits.some((a) => a.subjectId === draft.id && a.action === "note.created")).toBe(true);
  });

  it("converts a url-only capture using the URL as material", async () => {
    const auth = await seed("draft-url");
    const capture = await commands.createCapture(auth, { text: "https://example.com/rfc-9457" });
    const { draft } = await commands.convertCaptureToDraft(auth, {
      captureId: capture.id,
      expectedVersion: capture.version,
      template: "tech-spec",
    });
    const [artifact] = await db.select().from(artifacts).where(eq(artifacts.id, draft.id));
    expect(artifact.kind).toBe("note");
    const [version] = await db.select().from(artifactVersions).where(eq(artifactVersions.id, artifact.currentVersionId!));
    expect(version.plainText).toContain("> https://example.com/rfc-9457");
  });

  it("refuses a second conversion and a stale version", async () => {
    const auth = await seed("draft-guards");
    const capture = await commands.createCapture(auth, { text: "Guard rail probe" });
    await commands.convertCaptureToDraft(auth, { captureId: capture.id, expectedVersion: capture.version, template: "product-spec" });
    const [now] = await db.select().from(captures).where(eq(captures.id, capture.id));
    await expect(
      commands.convertCaptureToDraft(auth, { captureId: capture.id, expectedVersion: now.version, template: "email" }),
    ).rejects.toMatchObject({ code: "conflict" });

    const fresh = await commands.createCapture(auth, { text: "Stale probe" });
    await expect(
      commands.convertCaptureToDraft(auth, { captureId: fresh.id, expectedVersion: fresh.version + 1, template: "email" }),
    ).rejects.toMatchObject({ code: "stale_write" });
  });

  it("never sees another workspace's capture", async () => {
    const mine = await seed("draft-tenant-a");
    const foreign = await seed("draft-tenant-b");
    const capture = await commands.createCapture(mine, { text: "Tenant probe" });
    await expect(
      commands.convertCaptureToDraft(foreign, { captureId: capture.id, expectedVersion: capture.version, template: "email" }),
    ).rejects.toMatchObject({ code: "stale_write" });
    const [still] = await db.select().from(captures).where(eq(captures.id, capture.id));
    expect(still.processingState).toBe("unprocessed");
  });
});
