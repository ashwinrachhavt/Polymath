// @vitest-environment jsdom
import { createElement } from "react";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import {
  RATIONALE_INFERRED,
  SESSION_BRIEF_DISCLOSURE,
  UNVERIFIED_CLAIMS_LINE,
  buildSessionBrief,
} from "@/domains/agents/session-brief";
import { SessionBriefPanel } from "@/components/polymath/workbench/session-brief-panel";
import type { SessionSummary } from "@/lib/agent-artifacts/types";

/*
 * Render-boundary tests for the session brief panel. The builder's unit tests
 * pin sections and tiers; these pin what actually leaves the render boundary:
 * the standing disclosure is on every render, a credential that slipped past
 * the parse-time scrub still cannot reach the DOM, the mandatory open section
 * renders even for an empty session, and no verified mark is ever drawn.
 *
 * value: protects=the rendered honesty contract (disclosure, redaction,
 * verified-never); fails_when=the footer drops the disclosure, an unredacted
 * secret reaches the DOM, the open section disappears on an empty session, or
 * a verified badge is drawn on a v1 brief;
 * seam=SessionBriefPanel rendered in jsdom with builder-produced data.
 */

const OPENAI_KEY = "sk-proj-QaZ9x8yW7vEuRtSbNmLk";
const DOTENV_VALUE = "hushhush42";

function summary(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    source: "codex",
    externalSessionId: "thread-xyz-789",
    cwd: "/home/pino/Polymath",
    startedAt: "2026-11-01T09:00:00Z",
    lastActivityAt: "2026-11-01T10:30:00Z",
    aiTitle: undefined,
    humanPrompts: [{ text: "Summarize the eval harness failures", at: "2026-11-01T09:00:00Z" }],
    filesTouched: [{ path: "src/lib/evals/load.ts", op: "edit" }],
    commandsRun: [{ cmd: "pnpm test", ok: true }],
    failures: [],
    tasks: [],
    ...overrides,
  };
}

function renderPanel(brief = buildSessionBrief({ summary: summary(), decisionNote: null })) {
  return render(createElement(SessionBriefPanel, { brief }));
}

afterEach(cleanup);

describe("session brief panel", () => {
  it("renders the standing disclosure line on every render", () => {
    const { container } = renderPanel();
    expect(container.textContent).toContain(SESSION_BRIEF_DISCLOSURE);
    expect(container.textContent).toContain("Nothing was sent to a model.");
  });

  it("never draws a verified mark on a v1 brief", () => {
    const { container } = renderPanel(buildSessionBrief({ summary: summary(), decisionNote: "recorded note" }));
    // "unverified" appears in the standing honesty line, so the lookbehind
    // rejects it — the word "verified" itself must not appear anywhere.
    expect(/(?<!un)verified/.test(container.textContent ?? "")).toBe(false);
  });

  it("renders no secret that slipped past the parse-time scrub", () => {
    const brief = buildSessionBrief({
      summary: summary({
        humanPrompts: [{ text: `Deploy with API_SECRET=${DOTENV_VALUE}`, at: undefined }],
        aiTitle: `Session about ${OPENAI_KEY}`,
      }),
      decisionNote: null,
    });
    const { container } = renderPanel(brief);
    const text = container.textContent ?? "";
    expect(text).not.toContain(OPENAI_KEY);
    expect(text).not.toContain(DOTENV_VALUE);
    expect(text).toContain("[redacted]");
  });

  it("renders the mandatory open section even for an empty session", () => {
    const { container } = renderPanel(
      buildSessionBrief({
        summary: summary({
          humanPrompts: [],
          filesTouched: [],
          commandsRun: [],
          failures: [],
          tasks: [],
        }),
        decisionNote: null,
      }),
    );
    const text = container.textContent ?? "";
    expect(text).toContain("No human prompt was parsed from this session.");
    expect(text).toContain("No file or command activity was parsed from this session.");
    expect(text).toContain("No failures and no open tasks were parsed from this session.");
    expect(text).toContain(UNVERIFIED_CLAIMS_LINE);
  });

  it("renders the recorded note, or the inferred fallback literal", () => {
    const recorded = renderPanel(buildSessionBrief({ summary: summary(), decisionNote: "Ship behind a flag" }));
    expect(recorded.container.textContent).toContain("Ship behind a flag");
    cleanup();

    const inferred = renderPanel();
    expect(inferred.container.textContent).toContain(RATIONALE_INFERRED);
  });
});
