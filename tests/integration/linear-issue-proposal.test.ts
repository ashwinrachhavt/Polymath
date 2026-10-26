import { randomUUID } from "crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { artifacts } from "@/domains/knowledge/schema";
import { makeTestDb, ownerAuth, seedWorkspace } from "../helpers/test-workspace";

/*
 * ASH-285 notes-surface semantics, against a real database (CI pgvector
 * service): the source must belong to the caller's workspace; a repeat call
 * on an unchanged source replays the existing draft instead of duplicating;
 * a changed source refreshes the same draft as a new committed version; and
 * concurrent identical calls collapse on the receipt ledger. Generation is
 * unconfigured in CI, so every draft here is the honest deterministic
 * scaffold - the generation path is covered by unit and e2e fixtures.
 */

const handle = makeTestDb();
const suite = handle ? describe : describe.skip;
let db: NonNullable<typeof handle>["db"];
let proposal: typeof import("@/domains/capture/linear-issue-proposal");
let notes: typeof import("@/domains/knowledge/notes");

beforeAll(async () => {
  if (!handle) return;
  ({ db } = handle);
  proposal = await import("@/domains/capture/linear-issue-proposal");
  notes = await import("@/domains/knowledge/notes");
});

afterAll(async () => {
  await handle?.client.end();
});

async function seed(slug: string) {
  const { userId, workspaceId } = await seedWorkspace(db, `${slug}-${Date.now()}`);
  return ownerAuth(userId, workspaceId);
}

type Auth = ReturnType<typeof ownerAuth>;

function noteText(content: unknown): string {
  return content && typeof (content as { text?: unknown }).text === "string" ? ((content as { text: string }).text as string) : "";
}

async function makeNote(auth: Auth, title: string, text: string) {
  return notes.createNote(auth, {
    idempotencyKey: randomUUID(),
    title,
    content: { format: "markdown", text },
    plainText: text,
    kind: "note",
  });
}

async function versionCount(artifactId: string) {
  const rows = await db.select({ id: artifacts.id }).from(artifacts).where(eq(artifacts.id, artifactId));
  return rows.length;
}

suite("linear issue proposal from a note", () => {
  it("creates a draft that carries its provenance marker and source link", async () => {
    const auth = await seed("issue-draft-create");
    const source = await makeNote(auth, "Roadmap ask", "Priya needs the Q3 roadmap by Friday.");
    const result = await proposal.draftLinearIssueFromNote(auth, { artifactId: source.id });
    expect(result.outcome).toBe("created");
    expect(result.generated).toBe(false); // no generation provider in CI: honest scaffold
    const draft = await notes.getNote(auth, result.artifactId);
    const text = noteText(draft?.content);
    expect(text).toContain(proposal.LINEAR_ISSUE_SOURCE_MARKER);
    expect(text).toContain(`[[Roadmap ask]]`);
    expect(text).toContain("## Acceptance criteria");
  });

  it("refuses a note outside the caller's workspace", async () => {
    const owner = await seed("issue-draft-owner");
    const outsider = await seed("issue-draft-outsider");
    const source = await makeNote(owner, "Private", "Secret plans.");
    await expect(proposal.draftLinearIssueFromNote(outsider, { artifactId: source.id })).rejects.toThrow("No such note.");
  });

  it("replays the existing draft when the source is unchanged", async () => {
    const auth = await seed("issue-draft-replay");
    const source = await makeNote(auth, "Replay me", "Same text, twice.");
    const first = await proposal.draftLinearIssueFromNote(auth, { artifactId: source.id });
    const second = await proposal.draftLinearIssueFromNote(auth, { artifactId: source.id });
    expect(second.outcome).toBe("replayed");
    expect(second.artifactId).toBe(first.artifactId);
    expect(await versionCount(first.artifactId)).toBe(1);
  });

  it("refreshes the same draft when the source changes", async () => {
    const auth = await seed("issue-draft-refresh");
    const source = await makeNote(auth, "Evolving note", "Version one of the plan.");
    const first = await proposal.draftLinearIssueFromNote(auth, { artifactId: source.id });
    await notes.commitNoteSnapshot(auth, {
      idempotencyKey: randomUUID(),
      artifactId: source.id,
      expectedVersion: (await notes.getNote(auth, source.id))!.version,
      content: { format: "markdown", text: "Version two of the plan, now with a launch date." },
      plainText: "Version two of the plan, now with a launch date.",
    });
    const second = await proposal.draftLinearIssueFromNote(auth, { artifactId: source.id });
    expect(second.outcome).toBe("refreshed");
    expect(second.artifactId).toBe(first.artifactId);
    const draft = await notes.getNote(auth, first.artifactId);
    expect(noteText(draft?.content)).toContain("Version two of the plan");
  });

  it("collapses concurrent identical calls on the receipt ledger", async () => {
    const auth = await seed("issue-draft-concurrent");
    const source = await makeNote(auth, "Race me", "Concurrent drafting.");
    const [a, b] = await Promise.all([
      proposal.draftLinearIssueFromNote(auth, { artifactId: source.id }),
      proposal.draftLinearIssueFromNote(auth, { artifactId: source.id }),
    ]);
    expect(a.artifactId).toBe(b.artifactId);
    expect(["created", "replayed"]).toContain(a.outcome);
    expect(["created", "replayed"]).toContain(b.outcome);
  });
});
