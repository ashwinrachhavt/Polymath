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

suite("ordering and ownership", () => {
  it("an older generation finishing last never overwrites the newer draft", async () => {
    const auth = await seed("issue-draft-race-order");
    const source = await makeNote(auth, "Shifting note", "Version one of the plan.");

    // Call A starts from version one with a slow provider; before it finishes,
    // the source moves to version two and call B completes with a fast one.
    let releaseSlow!: (text: string) => void;
    const slow = new Promise<string>((resolve) => {
      releaseSlow = resolve;
    });
    const providerOf = (gate: Promise<string> | null, title: string) => ({
      name: `test:${title}`,
      registryId: "fixture",
      async generate() {
        const t = gate ? await gate : title;
        return {
          text: JSON.stringify({ title: t, problem: "P", proposal: "Q", acceptanceCriteria: ["A"], outOfScope: "O" }),
        };
      },
    });

    const callA = proposal.draftLinearIssueFromNote(auth, { artifactId: source.id }, { provider: providerOf(slow, "from version one") });
    await new Promise((r) => setTimeout(r, 50)); // A is now parked on the slow provider

    await notes.commitNoteSnapshot(auth, {
      idempotencyKey: randomUUID(),
      artifactId: source.id,
      expectedVersion: (await notes.getNote(auth, source.id))!.version,
      content: { format: "markdown", text: "Version two of the plan." },
      plainText: "Version two of the plan.",
    });
    const callB = proposal.draftLinearIssueFromNote(auth, { artifactId: source.id }, { provider: providerOf(null, "from version two") });
    const resultB = await callB;
    expect(resultB.outcome).toBe("created");
    expect(resultB.title).toBe("Linear issue: from version two");

    // A's stale generation finishes last; it must lose to B's newer draft.
    releaseSlow("from version one");
    const resultA = await callA;
    expect(resultA.artifactId).toBe(resultB.artifactId);
    expect(resultA.outcome).toBe("replayed");
    const draft = await notes.getNote(auth, resultB.artifactId);
    expect(noteText(draft?.content)).toContain("from version two");
    expect(noteText(draft?.content)).not.toContain("from version one");
  });

  it("owner edits block a silent refresh; the owner's text survives", async () => {
    const auth = await seed("issue-draft-owner-edits");
    const source = await makeNote(auth, "Owned", "First plan.");
    const first = await proposal.draftLinearIssueFromNote(auth, { artifactId: source.id });
    expect(first.outcome).toBe("created");

    // The owner edits the proposal (criteria section) and commits their
    // version; the provenance marker survives, as it does through the editor.
    const original = noteText((await notes.getNote(auth, first.artifactId))?.content);
    const ownerText = original.replace("## Acceptance criteria", "## Acceptance criteria\n\nMy hand-tuned notes, do not lose.");
    await notes.commitNoteSnapshot(auth, {
      idempotencyKey: randomUUID(),
      artifactId: first.artifactId,
      expectedVersion: (await notes.getNote(auth, first.artifactId))!.version,
      content: { format: "markdown", text: ownerText },
      plainText: ownerText,
    });

    // The source moves; refresh would destroy the owner's words, so it refuses.
    await notes.commitNoteSnapshot(auth, {
      idempotencyKey: randomUUID(),
      artifactId: source.id,
      expectedVersion: (await notes.getNote(auth, source.id))!.version,
      content: { format: "markdown", text: "Second plan." },
      plainText: "Second plan.",
    });
    await expect(proposal.draftLinearIssueFromNote(auth, { artifactId: source.id })).rejects.toThrow(/your edits/);
    const draft = await notes.getNote(auth, first.artifactId);
    expect(noteText(draft?.content)).toBe(ownerText);
  });

  it("an unsaved working draft on the proposal blocks the refresh", async () => {
    const auth = await seed("issue-draft-unsaved");
    const source = await makeNote(auth, "Unsaved", "First plan.");
    const first = await proposal.draftLinearIssueFromNote(auth, { artifactId: source.id });

    await notes.autosaveNoteDraft(auth, {
      artifactId: first.artifactId,
      expectedVersion: (await notes.getNote(auth, first.artifactId))!.version,
      content: { format: "markdown", text: "half-typed edit" },
    });

    await notes.commitNoteSnapshot(auth, {
      idempotencyKey: randomUUID(),
      artifactId: source.id,
      expectedVersion: (await notes.getNote(auth, source.id))!.version,
      content: { format: "markdown", text: "Second plan." },
      plainText: "Second plan.",
    });
    await expect(proposal.draftLinearIssueFromNote(auth, { artifactId: source.id })).rejects.toThrow(/unsaved changes/);
    const draft = await notes.getNote(auth, first.artifactId);
    expect(noteText(draft?.content)).not.toContain("Second plan");
  });
});

/*
 * ASH-285 conversation (assistant tool) path: the source is pasted text, not
 * a note, and the source id derives deterministically from the workspace and
 * the caller's stable key. The same commit core applies: replay on an
 * unchanged source, refresh on a changed one, and an owner-edited draft is
 * never overwritten.
 */
suite("linear issue proposal from conversation text", () => {
  it("creates a draft whose provenance marker names the derived conversation source", async () => {
    const auth = await seed("linear-text");
    const result = await proposal.draftLinearIssueFromText(auth, {
      title: "Pasted bug report",
      text: "The inbox badge keeps a count after the capture is filed.",
      sourceKey: "run-1:report-1",
    });
    expect(result.outcome).toBe("created");
    const sourceId = proposal.conversationSourceId(auth.workspaceId, "run-1:report-1");
    const draft = await notes.getNote(auth, result.artifactId);
    const text = noteText(draft?.content);
    expect(text).toContain(`linear-issue-source: ${sourceId}@`);
    // No dangling wiki-link: conversation provenance names the source in prose.
    expect(text).toContain("Drafted from the conversation (Pasted bug report).");
    expect(text).not.toContain("Drafted from [[");
  });

  it("replays the same draft when the same source is drafted twice", async () => {
    const auth = await seed("linear-text-replay");
    const input = { title: "Pasted idea", text: "A weekly review that writes itself.", sourceKey: "run-2:idea-1" };
    const first = await proposal.draftLinearIssueFromText(auth, input);
    const second = await proposal.draftLinearIssueFromText(auth, input);
    expect(second.artifactId).toBe(first.artifactId);
    expect(second.outcome).toBe("replayed");
  });

  it("refreshes the same draft as a new version when the source text changes", async () => {
    const auth = await seed("linear-text-refresh");
    const first = await proposal.draftLinearIssueFromText(auth, { title: "Pasted idea", text: "Version one of the idea.", sourceKey: "run-3:idea-1" });
    const second = await proposal.draftLinearIssueFromText(auth, { title: "Pasted idea", text: "Version two of the idea, now with detail.", sourceKey: "run-3:idea-1" });
    expect(second.artifactId).toBe(first.artifactId);
    expect(second.outcome).toBe("refreshed");
  });

  it("keeps the same material in two conversations as two separate drafts", async () => {
    const auth = await seed("linear-text-sessions");
    const text = "The capture inbox badge never clears.";
    const first = await proposal.draftLinearIssueFromText(auth, { title: "Pasted report", text, sourceKey: "wrun_session-a:bug-1" });
    const second = await proposal.draftLinearIssueFromText(auth, { title: "Pasted report", text, sourceKey: "wrun_session-b:bug-1" });
    expect(first.artifactId).not.toBe(second.artifactId);
    // Each conversation then replays its own draft.
    const replay = await proposal.draftLinearIssueFromText(auth, { title: "Pasted report", text, sourceKey: "wrun_session-a:bug-1" });
    expect(replay.artifactId).toBe(first.artifactId);
    expect(replay.outcome).toBe("replayed");
  });

  it("refuses an empty source instead of inventing an issue", async () => {
    const auth = await seed("linear-text-empty");
    await expect(proposal.draftLinearIssueFromText(auth, { title: "Nothing", text: "   ", sourceKey: "run-4:empty" })).rejects.toMatchObject({ code: "empty_source" });
  });
});
