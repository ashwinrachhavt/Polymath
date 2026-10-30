import { z } from "zod";

const base = {
  target: z.enum(["reply", "toolCall", "toolInput", "firstSentence", "fixture"]),
  key: z.string().optional(),
  tool: z.string().optional(),
  severity: z.enum(["gate", "soft"]),
  threshold: z.number().min(0).max(1).optional(),
  label: z.string().min(1),
};
export type Predicate = (value: unknown) => boolean;
export type SchemaMatcher = { "~standard": { validate: (value: unknown) => unknown | Promise<unknown> } };
function isPredicate(value: unknown): value is Predicate { return typeof value === "function"; }
function isSchema(value: unknown): value is SchemaMatcher {
  return typeof value === "object" && value !== null && "~standard" in value
    && typeof value["~standard"] === "object" && value["~standard"] !== null
    && "validate" in value["~standard"] && typeof value["~standard"].validate === "function";
}
export const assertionSchema = z.discriminatedUnion("kind", [
  z.object({ ...base, kind: z.literal("includes"), expected: z.union([z.string(), z.instanceof(RegExp)]) }),
  z.object({ ...base, kind: z.literal("equals"), expected: z.unknown() }),
  z.object({ ...base, kind: z.literal("satisfies"), predicate: z.custom<Predicate>(isPredicate, "expected a predicate function") }),
  z.object({ ...base, kind: z.literal("matches"), schema: z.custom<SchemaMatcher>(isSchema, "expected a Standard Schema") }),
]);
export const evalCaseSchema = z.object({
  id: z.string().min(1),
  suite: z.enum(["routing", "approval-classifier", "chat-grounding", "desirable-outputs"]),
  fixtureOnly: z.boolean(),
  objective: z.string().min(1).max(2000),
  estimateUsd: z.string().regex(/^\d+(\.\d{1,4})?$/).default("0.50"),
  profileName: z.string().min(1).default("polymath"),
  assertions: z.array(assertionSchema).min(1),
});
export type Assertion = z.infer<typeof assertionSchema>;
export type EvalCase = z.infer<typeof evalCaseSchema>;
export type CaseInput = z.input<typeof evalCaseSchema>;
export type Observation = {
  reply: string;
  toolCalls: { name: string; input: unknown }[];
  fixture: Record<string, unknown>;
};
export function firstSentence(message: string): string {
  const firstLine = message.split("\n").map((line) => line.trim()).find(Boolean) ?? "";
  return firstLine.split(/[.!?]/)[0] ?? "";
}
export function selectSubject(assertion: Assertion, observation: Observation): unknown {
  switch (assertion.target) {
    case "reply": return observation.reply;
    case "firstSentence": return firstSentence(observation.reply);
    case "fixture": return observation.fixture[assertion.key ?? ""];
    case "toolCall": return observation.toolCalls.some((call) => call.name === assertion.tool);
    case "toolInput": {
      const input = observation.toolCalls.find((call) => call.name === assertion.tool)?.input;
      return assertion.key && typeof input === "object" && input !== null
        ? Reflect.get(input, assertion.key) : input;
    }
  }
}
export function parseCase(value: unknown): EvalCase { return evalCaseSchema.parse(value); }
export function loadCases(values: readonly unknown[]): EvalCase[] {
  const cases = values.map(parseCase);
  const seen = new Set<string>();
  for (const item of cases) {
    if (seen.has(item.id)) throw new Error(`Duplicate eval case id: ${item.id}`);
    seen.add(item.id);
  }
  return cases;
}


