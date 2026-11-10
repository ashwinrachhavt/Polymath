import { parseCase, type Assertion } from "./types";
export const COMPLETED_TITLES = ["Ship invoice PDF export", "Migrate billing webhooks to v2"];
export const TODAY_TITLES = ["Review Q4 vendor contract", "Prepare board update deck"];
const tool = (name: string): Assertion => ({
  kind: "equals",
  target: "toolCall",
  tool: name,
  severity: "gate",
  label: `calls ${name}`,
  expected: true,
});
const MISSING_RECORDS_OPENER = /no (calendar|meetings)|cannot see/i;
export { cases as default };
const cases = [
  parseCase({
    id: "desirable-outputs/whatIsOnMyPlateToday",
    suite: "desirable-outputs",
    fixtureOnly: false,
    objective: "What is on my plate today?",
    assertions: [
      tool("tasks_recent"),
      tool("tasks_read"),
      ...[...COMPLETED_TITLES, ...TODAY_TITLES].map((expected): Assertion => ({
        kind: "includes",
        target: "reply",
        severity: "gate",
        label: `surfaces ${expected}`,
        expected,
      })),
      {
        kind: "satisfies",
        target: "firstSentence",
        severity: "gate",
        label: "opens with found data",
        predicate: (v: unknown) => !MISSING_RECORDS_OPENER.test(String(v)),
      },
    ],
  }),
];
