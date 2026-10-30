import { MODEL_ROUTING_OPTIONS, ROUTING_FALLBACK } from "../scoring/policy";
import { parseCase } from "./types";
export { cases as default };
const cases = [parseCase({
  id: "routing/allowlist", suite: "routing", fixtureOnly: true,
  objective: "Verify routine and difficult routing, off-allowlist rejection and fallback.",
  assertions: [
    { kind: "satisfies", target: "fixture", key: "allowlist", severity: "gate", label: "allowlist includes fallback and at least two options", predicate: (v: unknown) => Array.isArray(v) && v.length >= 2 && v.includes(ROUTING_FALLBACK) },
    { kind: "equals", target: "fixture", key: "routine", severity: "gate", label: "routine route is not fallback", expected: { model: "gemini-3.5-flash-lite", fellBack: false } },
    { kind: "equals", target: "fixture", key: "hard", severity: "gate", label: "difficult route", expected: { model: "gpt-6.1-terra", fellBack: false } },
    { kind: "includes", target: "fixture", key: "rejection", severity: "gate", label: "off-allowlist rejection", expected: "selected an unknown option" },
    { kind: "equals", target: "fixture", key: "fallback", severity: "gate", label: "fallback flag and allowlisted value", expected: { model: ROUTING_FALLBACK, fellBack: true } },
    { kind: "equals", target: "fixture", key: "allowlist", severity: "gate", label: "policy source unchanged", expected: Object.keys(MODEL_ROUTING_OPTIONS) },
  ],
})];
