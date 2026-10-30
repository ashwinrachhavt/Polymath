import { parseCase, type Assertion } from "./types";
export const expectedPolicy = [
  { capability: "tasks.read", risk: "read", outcome: "clear", status: "approved" },
  { capability: "gmail.draft", risk: "prepare", outcome: "clear", status: "approved" },
  { capability: "gmail.send", risk: "external_write", outcome: "caution", status: "user-approval" },
  { capability: "vercel.deploy", risk: "sensitive_write", outcome: "caution", status: "user-approval" },
  { capability: "credentials.export", risk: "prohibited", outcome: "deny", status: "denied" },
] as const;
const rows: Assertion[] = expectedPolicy.map((row) => ({
  kind: "equals", target: "fixture", key: row.capability, severity: "gate", label: `policy and classifier agree for ${row.capability}`,
  expected: { risk: row.risk, status: row.status, answer: row.outcome, agrees: true },
}));
export { cases as default };
const cases = [parseCase({
  id: "approval-classifier/policy", suite: "approval-classifier", fixtureOnly: true,
  objective: "Verify all risk classes and fail-closed approval classification.",
  assertions: [
    { kind: "includes", target: "fixture", key: "policy", severity: "gate", label: "external write policy", expected: "external write" },
    { kind: "equals", target: "fixture", key: "criteriaDescribed", severity: "gate", label: "all criteria described", expected: true },
    ...rows,
    { kind: "equals", target: "fixture", key: "gmail.undeclared", severity: "gate", label: "undeclared capability fails closed", expected: "deny" },
  ],
})];
