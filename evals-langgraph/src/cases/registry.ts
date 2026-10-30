import routing from "./routing.case";
import approval from "./approval-classifier.case";
import chat from "./chat-grounding.case";
import desirable from "./desirable-outputs.case";
import { assertEvalEnvironment } from "../env-gate";
import { loadCases, type EvalCase } from "./types";
export function caseRegistry(env: Readonly<Record<string, string | undefined>>): EvalCase[] {
  assertEvalEnvironment(env);
  return loadCases([...routing, ...approval, ...chat, ...desirable]);
}
