import { describe, expect, it } from "vitest";
import { bugAgentConfig } from "@/domains/bug-triage/pass";
import { sentryWebhookBody, signalFromReport, signalFromSentry } from "@/domains/bug-triage/signal";
import { draftIssue, filesForRoute, triageSignal } from "@/domains/bug-triage/triage";

/** Shaped like Sentry's documented `event_alert` payload, with the private fields Sentry really sends. */
function sentryAlert(overrides: { issueId?: string; type?: string; frames?: unknown[] } = {}) {
  return {
    action: "triggered",
    data: {
      event: {
        issue_id: overrides.issueId ?? "1170820242",
        event_id: "bb78c1407cea4519aa397afc059c793d",
        title: "TypeError: Cannot read properties of undefined (reading 'title')",
        level: "error",
        culprit: "notes/[id]",
        web_url: "https://sentry.io/organizations/polymath/issues/1170820242/events/bb78c1407cea4519aa397afc059c793d/",
        metadata: { type: "TypeError", value: "Cannot read properties of undefined (reading 'title')" },
        exception: {
          values: [
            {
              type: overrides.type ?? "TypeError",
              value: "Cannot read properties of undefined (reading 'title') for ada@example.com",
              stacktrace: {
                frames: overrides.frames ?? [
                  {
                    abs_path: "/app/node_modules/react-dom/cjs/react-dom.js",
                    lineno: 10,
                    function: "render",
                    in_app: false,
                  },
                  {
                    abs_path: "app:///src/app/(workspace)/notes/[id]/page.tsx",
                    lineno: 40,
                    function: "NotePage",
                    in_app: true,
                  },
                  {
                    abs_path: "webpack-internal:///(rsc)/./src/domains/notes/queries.ts",
                    lineno: 88,
                    function: "noteTitle",
                    in_app: true,
                  },
                ],
              },
            },
          ],
        },
        request: { url: "https://polymath.example/notes/9f1c2a3b-1111-4222-8333-444455556666", cookies: "session=abc" },
        user: { ip_address: "162.218.85.90", email: "ada@example.com" },
        tags: [
          ["url", "https://polymath.example/notes/9f1c2a3b-1111-4222-8333-444455556666?x=1"],
          ["user", "ip:162.217.75.90"],
        ],
      },
      triggered_rule: "New issue",
    },
    installation: { uuid: "a8e5d37a-696c-4c54-adb5-b3f28d64c7de" },
  };
}

function parseSentry(body: unknown) {
  const signal = signalFromSentry(sentryWebhookBody.parse(body));
  if (!signal) throw new Error("expected a signal");
  return signal;
}

describe("fingerprints (dedupe identity)", () => {
  it("is the same for every event of one Sentry issue", () => {
    expect(parseSentry(sentryAlert()).fingerprint).toBe(parseSentry(sentryAlert()).fingerprint);
  });

  it("differs between Sentry issues", () => {
    expect(parseSentry(sentryAlert({ issueId: "1" })).fingerprint).not.toBe(
      parseSentry(sentryAlert({ issueId: "2" })).fingerprint,
    );
  });

  it("joins reports of one screen and error, whatever the record id or wording", () => {
    const a = signalFromReport({
      route: "/notes/9f1c2a3b-1111-4222-8333-444455556666",
      errorId: "123456",
      kind: "broken",
    });
    const b = signalFromReport({
      route: "/notes/0aaaaaaa-1111-4222-8333-444455556666?x=1",
      errorId: "123456",
      kind: "wrong",
    });
    expect(a.fingerprint).toBe(b.fingerprint);
  });

  it("separates reports with different errors on one screen", () => {
    const a = signalFromReport({ route: "/notes/1", errorId: "111", kind: "broken" });
    const b = signalFromReport({ route: "/notes/1", errorId: "222", kind: "broken" });
    expect(a.fingerprint).not.toBe(b.fingerprint);
  });
});

describe("signalFromSentry", () => {
  it("keeps the in-app frames innermost first and nothing private", () => {
    const signal = parseSentry(sentryAlert());
    expect(signal.frames).toEqual([
      { file: "src/domains/notes/queries.ts", line: 88, fn: "noteTitle" },
      { file: "src/app/(workspace)/notes/[id]/page.tsx", line: 40, fn: "NotePage" },
    ]);
    expect(signal.route).toBe("/notes/:id");
    expect(signal.sentryIssueUrl).toBe("https://sentry.io/organizations/polymath/issues/1170820242/");
    const serialized = JSON.stringify(signal);
    for (const secret of ["ada@example.com", "162.218", "162.217", "session=abc", "9f1c2a3b", "bb78c140"]) {
      expect(serialized).not.toContain(secret);
    }
  });

  it("drops an issue link that is not sentry.io", () => {
    const body = sentryAlert();
    body.data.event.web_url = "https://evil.example/organizations/x/issues/1170820242/";
    expect(parseSentry(body).sentryIssueUrl).toBeNull();
  });
});

describe("triage", () => {
  const pages = [
    "src/app/(workspace)/notes/[id]/page.tsx",
    "src/app/(workspace)/notes/page.tsx",
    "src/app/(workspace)/library/page.tsx",
  ];

  it("maps a route pattern to the page that renders it", () => {
    expect(filesForRoute("/notes/:id", pages)).toEqual(["src/app/(workspace)/notes/[id]/page.tsx"]);
    expect(filesForRoute("/library", pages)).toEqual(["src/app/(workspace)/library/page.tsx"]);
  });

  it("labels a simple in-app TypeError for an automatic fix", () => {
    const triage = triageSignal(parseSentry(sentryAlert()), { occurrences: 1, routeFiles: [] });
    expect(triage).toMatchObject({ area: "notes", severity: "medium", reproducibility: "once", autoFix: true });
    expect(triage.labels).toEqual(["bug-agent", "bug", "area:notes", "sev:medium", "repro:once", "agent:fix"]);
  });

  it("never asks for a fix when the trace starts in a protected path", () => {
    const signal = parseSentry(
      sentryAlert({
        frames: [{ abs_path: "app:///src/lib/auth.ts", lineno: 3, function: "getAuthContext", in_app: true }],
      }),
    );
    expect(triageSignal(signal, { occurrences: 5, routeFiles: [] }).autoFix).toBe(false);
  });

  it("never asks for a fix without a trace or for a complex error type", () => {
    const report = signalFromReport({ route: "/notes/1", errorId: "1", kind: "broken" });
    expect(triageSignal(report, { occurrences: 9, routeFiles: [] }).autoFix).toBe(false);
    expect(
      triageSignal(parseSentry(sentryAlert({ type: "PostgresError" })), { occurrences: 1, routeFiles: [] }).autoFix,
    ).toBe(false);
  });

  it("raises severity and reproducibility with sightings", () => {
    const report = signalFromReport({ route: "/notes/1", errorId: null, kind: "slow" });
    expect(triageSignal(report, { occurrences: 1, routeFiles: [] })).toMatchObject({
      severity: "low",
      reproducibility: "once",
    });
    expect(triageSignal(report, { occurrences: 25, routeFiles: [] })).toMatchObject({
      severity: "high",
      reproducibility: "recurring",
    });
  });

  it("writes an issue that carries the fingerprint, suspected files and related issues", () => {
    const signal = parseSentry(sentryAlert());
    const triage = triageSignal(signal, { occurrences: 3, routeFiles: filesForRoute(signal.route, pages) });
    const issue = draftIssue(signal, triage, {
      occurrences: 3,
      firstSeenAt: new Date("2026-11-12T00:00:00Z"),
      similar: [41],
    });
    expect(issue.body).toContain(signal.fingerprint);
    expect(issue.body).toContain("- `src/domains/notes/queries.ts`");
    expect(issue.body).toContain("- #41");
    expect(issue.body).not.toContain("ada@example.com");
  });
});

describe("bugAgentConfig (kill switch)", () => {
  const ready = { BUG_AGENT_ENABLED: "true", BUG_AGENT_GITHUB_TOKEN: "t", BUG_AGENT_REPO: "owner/repo" };

  it("is off unless explicitly enabled with a token and repository", () => {
    expect(bugAgentConfig({})).toBeNull();
    expect(bugAgentConfig({ ...ready, BUG_AGENT_ENABLED: "false" })).toBeNull();
    expect(bugAgentConfig({ ...ready, BUG_AGENT_GITHUB_TOKEN: "" })).toBeNull();
    expect(bugAgentConfig({ ...ready, BUG_AGENT_REPO: "not a repo" })).toBeNull();
  });

  it("defaults to five issues a day", () => {
    expect(bugAgentConfig(ready)).toEqual({ token: "t", repo: "owner/repo", maxIssuesPerDay: 5 });
    expect(bugAgentConfig({ ...ready, BUG_AGENT_MAX_ISSUES_PER_DAY: "2" })?.maxIssuesPerDay).toBe(2);
  });
});
