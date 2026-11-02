import { describe, expect, it } from "vitest";

import {
  RATIONALE_INFERRED,
  SESSION_BRIEF_DISCLOSURE,
  UNVERIFIED_CLAIMS_LINE,
  buildSessionBrief,
  isOpenTask,
  uniqueFiles,
  type SessionBriefData,
} from "@/domains/agents/session-brief";
import type { SessionSummary } from "@/lib/agent-artifacts/types";

/*
 * Brief-content tests per section and tier (Workbench D2). The sections and
 * their tiers are the re-spec's table; every claim a section makes must carry
 * the tier its evidence stands on, absence is reported and never dressed as a
 * tier, the verified tier is never awarded in v1, and the disclosure line is
 * mandatory on every brief.
 *
 * value: protects=the brief's honesty contract (sections, tiers, disclosure);
 * fails_when=a section renders a claim without its tier, an empty section
 * disappears, verified appears on a v1 brief, or the fallback literal drifts;
 * seam=buildSessionBrief in isolation, no React, no database.
 */

/**
 * Credential-shaped fakes: none may survive into a brief. Values only — the
 * assignment rule deliberately keeps key names readable.
 */
const OPENAI_KEY = "sk-proj-QaZ9x8yW7vEuRtSbNmLk";
const JWT = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJVadQssw5c";
const GITHUB_TOKEN = "ghp_abcdefghijklmnopqrst";
const ANTHROPIC_KEY = "sk-ant-abcdefghijklmnop";
const DOTENV_VALUE = "hushhush42";

function richSummary(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    source: "claude-code",
    externalSessionId: "session-abc-123",
    cwd: "/home/pino/Polymath",
    startedAt: "2026-11-01T09:00:00Z",
    lastActivityAt: "2026-11-01T10:30:00Z",
    aiTitle: "Fix the login redirect",
    humanPrompts: [
      { text: "Fix the login redirect on staging", at: "2026-11-01T09:00:00Z" },
      { text: "Second prompt, not the requested outcome", at: "2026-11-01T09:30:00Z" },
    ],
    filesTouched: [
      { path: "src/lib/auth.ts", op: "edit" },
      { path: "src/lib/auth.ts", op: "edit" },
      { path: "src/app/login/page.tsx", op: "write" },
    ],
    commandsRun: [
      { cmd: "pnpm test", ok: true },
      { cmd: "pnpm build", ok: false },
    ],
    failures: [{ kind: "command_failed", detail: "exit code 1" }],
    tasks: [
      { text: "Reproduce the redirect loop", state: "completed" },
      { text: "Add a redirect regression test", state: "pending" },
      { text: "Ask design about the banner", state: "in_progress" },
    ],
    usage: { inputTokens: 1200, outputTokens: 340 },
    ...overrides,
  };
}

function briefFor(summary: SessionSummary, decisionNote?: string | null): SessionBriefData {
  return buildSessionBrief({ summary, decisionNote });
}

/** Every tier the brief awards, across all sections. */
function allTiers(brief: SessionBriefData): string[] {
  return [brief.outcome.tier, brief.activity.tier, brief.open.tier, brief.decision.tier].map(String);
}

describe("requested outcome", () => {
  it("reads the first human prompt as recorded", () => {
    const brief = briefFor(richSummary(), "Ship behind a flag");
    expect(brief.outcome.tier).toBe("recorded");
    expect(brief.outcome.text).toBe("Fix the login redirect on staging");
    expect(brief.outcome.at).toBe("2026-11-01T09:00:00Z");
  });

  it("ignores later prompts because the first one is the ask", () => {
    const brief = briefFor(richSummary());
    expect(brief.outcome.text).not.toContain("Second prompt");
  });

  it("claims nothing when no human prompt was parsed", () => {
    const brief = briefFor(richSummary({ humanPrompts: [] }));
    expect(brief.outcome.tier).toBeNull();
    expect(brief.outcome.text).toBeNull();
    expect(brief.tierCounts.grounded).toBe(2); // activity + open; the decision without a note is inferred, not grounded
  });
});

describe("what the agent did", () => {
  it("is observed and dedupes repeated paths to unique files", () => {
    const brief = briefFor(richSummary());
    expect(brief.activity.tier).toBe("observed");
    expect(brief.activity.files).toHaveLength(2); // three touches, two unique paths
    expect(brief.activity.files?.map((file) => file.path)).toEqual(["src/lib/auth.ts", "src/app/login/page.tsx"]);
    expect(brief.activity.commands).toHaveLength(2);
    expect(brief.activity.commands?.map((command) => command.ok)).toEqual([true, false]);
  });

  it("keeps the first-seen op for a repeated path", () => {
    const files = uniqueFiles([
      { path: "src/lib/auth.ts", op: "edit" },
      { path: "src/lib/auth.ts", op: "write" },
    ]);
    expect(files).toEqual([{ path: "src/lib/auth.ts", op: "edit" }]);
  });

  it("claims nothing when the session touched no files and ran no commands", () => {
    const brief = briefFor(richSummary({ filesTouched: [], commandsRun: [], failures: [], tasks: [] }));
    expect(brief.activity.tier).toBeNull();
    expect(brief.activity.files).toBeNull();
  });
});

describe("what failed or was left open", () => {
  it("is observed and lists failures plus only unfinished tasks", () => {
    const brief = briefFor(richSummary());
    expect(brief.open.tier).toBe("observed");
    expect(brief.open.failures).toEqual([{ kind: "command_failed", detail: "exit code 1" }]);
    expect(brief.open.openTasks.map((task) => task.text)).toEqual([
      "Add a redirect regression test",
      "Ask design about the banner",
    ]);
  });

  it("stays observed even when nothing failed because the section is mandatory", () => {
    const brief = briefFor(richSummary({ failures: [], tasks: [] }));
    expect(brief.open.tier).toBe("observed");
    expect(brief.open.failures).toEqual([]);
    expect(brief.open.openTasks).toEqual([]);
  });

  it("treats an unknown task state as open and normalizes the completed check", () => {
    expect(isOpenTask({ text: "x", state: "completed" })).toBe(false);
    expect(isOpenTask({ text: "x", state: " Completed " })).toBe(false);
    expect(isOpenTask({ text: "x", state: "pending" })).toBe(true);
    expect(isOpenTask({ text: "x", state: "some-new-state" })).toBe(true);
  });
});

describe("why this approach", () => {
  it("reads a recorded note as recorded, trimmed", () => {
    const brief = briefFor(richSummary(), "  Ship behind a flag: staging is broken.  ");
    expect(brief.decision.tier).toBe("recorded");
    expect(brief.decision.line).toBe("Ship behind a flag: staging is broken.");
  });

  it("renders the inferred fallback literal when no note was given", () => {
    for (const note of [null, undefined, "   "]) {
      const brief = briefFor(richSummary(), note);
      expect(brief.decision.tier).toBe("inferred");
      expect(brief.decision.line).toBe(RATIONALE_INFERRED);
      expect(brief.decision.line).toBe("rationale inferred after implementation");
    }
  });
});

describe("standing rules", () => {
  it("never awards the verified tier, and hypotheses stay zero", () => {
    const brief = briefFor(richSummary(), "recorded note");
    expect(allTiers(brief)).not.toContain("verified");
    expect(brief.tierCounts.hypothesis).toBe(0);
  });

  it("carries the disclosure line verbatim on every brief", () => {
    for (const brief of [
      briefFor(richSummary(), "note"),
      briefFor(richSummary({ humanPrompts: [], filesTouched: [], commandsRun: [], failures: [], tasks: [] })),
    ]) {
      expect(brief.disclosure).toBe(SESSION_BRIEF_DISCLOSURE);
      expect(brief.disclosure).toBe("Parsed locally from your Claude Code / Codex files. Nothing was sent to a model.");
    }
  });

  it("carries the standing unverified-claims line in the open section", () => {
    expect(UNVERIFIED_CLAIMS_LINE).toContain("unverified");
  });
});

describe("tier counts", () => {
  it("mirror the rendered sections: rich brief with a recorded note", () => {
    const brief = briefFor(richSummary(), "recorded note");
    expect(brief.tierCounts).toEqual({ grounded: 4, inferred: 0, hypothesis: 0 }); // outcome + activity + open + decision
  });

  it("mirror the rendered sections: no note means the decision counts as inferred", () => {
    const brief = briefFor(richSummary());
    expect(brief.tierCounts).toEqual({ grounded: 3, inferred: 1, hypothesis: 0 });
  });

  it("mirror the rendered sections: an empty session still renders open plus an inferred decision", () => {
    const brief = briefFor(
      richSummary({ humanPrompts: [], filesTouched: [], commandsRun: [], failures: [], tasks: [] }),
    );
    expect(brief.tierCounts).toEqual({ grounded: 1, inferred: 1, hypothesis: 0 });
  });
});

describe("redaction at the render boundary", () => {
  it("scrubs credential shapes from every transcript-extracted field", () => {
    const brief = briefFor(
      richSummary({
        aiTitle: `Session about ${OPENAI_KEY}`,
        humanPrompts: [{ text: `Deploy with API_SECRET=${DOTENV_VALUE} please`, at: "2026-11-01T09:00:00Z" }],
        commandsRun: [{ cmd: `curl -H 'x-okta: ${JWT}'`, ok: false }],
        failures: [{ kind: "leak", detail: `pushed with ${GITHUB_TOKEN}` }],
        tasks: [{ text: `rotate the key ${ANTHROPIC_KEY}`, state: "pending" }],
      }),
    );

    const rendered = JSON.stringify(brief);
    for (const secret of [OPENAI_KEY, JWT, GITHUB_TOKEN, ANTHROPIC_KEY, DOTENV_VALUE]) {
      expect(rendered, `secret leaked: ${secret.slice(0, 12)}...`).not.toContain(secret);
    }
    // The scrub replaces with the deterministic marker; assignment key names stay readable.
    expect(brief.outcome.tier === "recorded" && brief.outcome.text).toContain("[redacted]");
    expect(rendered).toContain("[redacted]");
  });

  it("scrubs credential-shaped file paths too", () => {
    const brief = briefFor(
      richSummary({ filesTouched: [{ path: `/tmp/dump/API_KEY=${DOTENV_VALUE}.txt`, op: "write" }] }),
    );
    expect(JSON.stringify(brief)).not.toContain(DOTENV_VALUE);
  });
});
