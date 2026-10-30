import { parseCase, type Assertion } from "./types";
export const DISTINCTIVE_PHRASE = "The inbox badge shows 3 unread after I archived everything — the count is not decrementing on archive";
export const LATE_PHRASE = "Started after the Vantablack sync migration shipped on the 14th";
export const PASTED_REPORT = [
  "Pasting a bug report from QA notes — please turn this into a Linear issue:", "",
  '"The inbox badge shows 3 unread after I archived everything — the count is not '
    + "decrementing on archive. Reproduced on iOS 26.1 and desktop; web is fine. "
    + "Steps: open the inbox, archive all five threads, return to the home screen. "
    + "The badge keeps its stale total until the app is force-quit. A second observer "
    + "saw the same thing on her account, so it is not tied to one workspace member. "
    + "The stale count also survives a background refresh, but a manual pull-to-refresh "
    + "clears it. Started after the Vantablack sync migration shipped on the 14th; the "
    + "badge used to clear within a second before that release. Console shows a repeated "
    + '\"badge delta ignored\" warning each time an archive lands.\"',
].join("\n");
export const COMPLETED_TITLES = ["Ship invoice PDF export", "Migrate billing webhooks to v2"];
export const TODAY_TITLES = ["Review Q4 vendor contract", "Prepare board update deck"];
const tool = (name: string): Assertion => ({ kind: "equals", target: "toolCall", tool: name, severity: "gate", label: `calls ${name}`, expected: true });
const CREATION_CLAIM = /created (an|the) issue|filed (it|this|a|the|an|to)|submitted to Linear/i;
const MISSING_RECORDS_OPENER = /no (calendar|meetings)|cannot see/i;
export { cases as default };
const cases = [
  parseCase({ id: "desirable-outputs/linearDraftFromPastedMaterial", suite: "desirable-outputs", fixtureOnly: false,
    objective: PASTED_REPORT, assertions: [tool("linear_issue_propose"),
      ...[DISTINCTIVE_PHRASE, LATE_PHRASE].map((expected): Assertion => ({ kind: "includes", target: "toolInput", tool: "linear_issue_propose", key: "text", severity: "gate", label: `verbatim ${expected}`, expected })),
      { kind: "includes", target: "reply", severity: "gate", label: "draft framing", expected: /proposal|draft|review/i },
      { kind: "satisfies", target: "reply", severity: "gate", label: "no creation claim", predicate: (v: unknown) => !CREATION_CLAIM.test(String(v)) },
    ] }),
  parseCase({ id: "desirable-outputs/whatIsOnMyPlateToday", suite: "desirable-outputs", fixtureOnly: false,
    objective: "What is on my plate today?", assertions: [tool("tasks_recent"), tool("tasks_read"),
      ...[...COMPLETED_TITLES, ...TODAY_TITLES].map((expected): Assertion => ({ kind: "includes", target: "reply", severity: "gate", label: `surfaces ${expected}`, expected })),
      { kind: "satisfies", target: "firstSentence", severity: "gate", label: "opens with found data", predicate: (v: unknown) => !MISSING_RECORDS_OPENER.test(String(v)) },
    ] }),
];
