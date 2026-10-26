import { describe, expect, it } from "vitest";
import {
  buildLinearIssuePrompt,
  conversationSourceId,
  LINEAR_ISSUE_SYSTEM_MARKER,
  LINEAR_ISSUE_SYSTEM_PROMPT,
  LinearIssueProposalError,
  parseLinearIssueProposal,
  renderLinearIssueDraft,
} from "@/domains/capture/linear-issue-proposal";
import { fixtureProvider } from "@/integrations/generation/fixture";

/*
 * ASH-285 part 2: the fully-formed proposal contract. The parse and render
 * halves are pure so the model's output shape is pinned by tests, and the
 * fixture provider answers the marker so e2e can click through without a key.
 */

describe("buildLinearIssuePrompt", () => {
  it("quotes the source with its title", () => {
    const prompt = buildLinearIssuePrompt({ title: "Roadmap note", text: "Send the Q3 roadmap to Priya." });
    expect(prompt).toContain("SOURCE TITLE: Roadmap note");
    expect(prompt).toContain("Send the Q3 roadmap to Priya.");
  });

  it("refuses empty source material instead of inventing an issue", () => {
    expect(() => buildLinearIssuePrompt({ title: "T", text: "  \n " })).toThrow(LinearIssueProposalError);
  });

  it("cuts very long sources with an explicit marker", () => {
    const prompt = buildLinearIssuePrompt({ title: "T", text: "x".repeat(9000) });
    expect(prompt).toContain("the source continues");
    expect(prompt.length).toBeLessThan(9000);
  });
});

describe("parseLinearIssueProposal", () => {
  const good = JSON.stringify({
    title: "Ship the thing",
    problem: "It is missing.",
    proposal: "Build the smallest version.",
    acceptanceCriteria: ["The thing exists", "The old path still works"],
    outOfScope: "Everything else.",
  });

  it("parses a well-formed answer", () => {
    const p = parseLinearIssueProposal(good);
    expect(p.title).toBe("Ship the thing");
    expect(p.acceptanceCriteria).toHaveLength(2);
  });

  it("rejects non-JSON and missing sections", () => {
    expect(() => parseLinearIssueProposal("not json")).toThrow(LinearIssueProposalError);
    expect(() => parseLinearIssueProposal(JSON.stringify({ title: "T" }))).toThrow(LinearIssueProposalError);
    expect(() =>
      parseLinearIssueProposal(JSON.stringify({ title: "T", problem: "P", proposal: "Q", acceptanceCriteria: [], outOfScope: "O" })),
    ).toThrow(LinearIssueProposalError);
  });

  it("drops non-string acceptance criteria", () => {
    const p = parseLinearIssueProposal(
      JSON.stringify({ title: "T", problem: "P", proposal: "Q", acceptanceCriteria: ["real", 7, null], outOfScope: "O" }),
    );
    expect(p.acceptanceCriteria).toEqual(["real"]);
  });
});

describe("renderLinearIssueDraft", () => {
  it("renders the issue shape with the source quoted and the proposer named", () => {
    const body = renderLinearIssueDraft(
      { title: "Ship", problem: "Missing.", proposal: "Build it.", acceptanceCriteria: ["It works"], outOfScope: "The rest." },
      { sourceMaterial: "Line one\nLine two", proposer: "fixture:e2e" },
    );
    expect(body).toContain("# Ship");
    expect(body).toContain("## Acceptance criteria");
    expect(body).toContain("- [ ] It works");
    expect(body).toContain("> Line one\n> Line two");
    expect(body).toContain("Proposed by fixture:e2e");
    expect(body).toContain("nothing has been sent to Linear");
  });
});

describe("fixture provider", () => {
  it("answers the Linear-issue marker with a parseable proposal", async () => {
    const out = await fixtureProvider().generate({ system: LINEAR_ISSUE_SYSTEM_PROMPT, prompt: buildLinearIssuePrompt({ title: "T", text: "Priya needs the roadmap." }) });
    const p = parseLinearIssueProposal(out.text);
    expect(p.title).toContain("roadmap");
    expect(LINEAR_ISSUE_SYSTEM_PROMPT).toContain(LINEAR_ISSUE_SYSTEM_MARKER);
  });
});

import { bodyWithoutMarker, LINEAR_ISSUE_SOURCE_MARKER, parseSourceMarker, sourceHashOf, sourceMarkerOf } from "@/domains/capture/linear-issue-proposal";

describe("source provenance marker", () => {
  const id = "123e4567-e89b-42d3-a456-426614174000";

  it("round-trips source id, source hash and body hash", () => {
    const hash = sourceHashOf("the source text");
    const body = sourceHashOf("the draft body");
    const marker = sourceMarkerOf(id, hash, body);
    expect(marker).toBe(`<!-- ${LINEAR_ISSUE_SOURCE_MARKER}: ${id}@${hash}:b${body} -->`);
    expect(parseSourceMarker(`body\n\n${marker}\n`)).toEqual({ sourceId: id, sourceHash: hash, bodyHash: body });
  });

  it("strips the marker to recover the attested body", () => {
    const body = "the draft body\n\nDrafted from [[Note]].";
    const marker = sourceMarkerOf(id, sourceHashOf("s"), sourceHashOf(body));
    expect(bodyWithoutMarker(`${body}\n\n${marker}`)).toBe(body);
    expect(sourceHashOf(bodyWithoutMarker(`${body}\n\n${marker}`))).toBe(sourceHashOf(body));
  });

  it("hash changes when the source changes, so refresh is detectable", () => {
    expect(sourceHashOf("v1")).not.toBe(sourceHashOf("v2"));
    expect(sourceHashOf("same")).toBe(sourceHashOf("same"));
  });

  it("ignores absent or malformed markers", () => {
    expect(parseSourceMarker("no marker here")).toBeNull();
    expect(parseSourceMarker(`<!-- ${LINEAR_ISSUE_SOURCE_MARKER}: not-a-uuid@xyz -->`)).toBeNull();
    expect(parseSourceMarker(`<!-- ${LINEAR_ISSUE_SOURCE_MARKER}: ${id}@${sourceHashOf("s")} -->`)).toBeNull(); // older marker shape
  });
});

describe("conversationSourceId", () => {
  it("is deterministic per workspace and key, and fits the marker's UUID shape", () => {
    const a = conversationSourceId("ws-1", "run:1");
    const b = conversationSourceId("ws-1", "run:1");
    const other = conversationSourceId("ws-1", "run:2");
    const otherWs = conversationSourceId("ws-2", "run:1");
    expect(a).toBe(b);
    expect(a).not.toBe(other);
    expect(a).not.toBe(otherWs);
    // parseSourceMarker only matches UUID-shaped source ids; a derived id that
    // misses the shape would make every conversation draft unfindable.
    const marker = sourceMarkerOf(a, sourceHashOf("s"), sourceHashOf("b"));
    expect(parseSourceMarker(marker)).toEqual({ sourceId: a, sourceHash: sourceHashOf("s"), bodyHash: sourceHashOf("b") });
  });
});
