import { KeyHasNoOwnerError } from "@/domains/understanding/actor";
import {
  ExplainerNotFoundError,
  ExplainerNotReadyError,
  InvalidCheckAnswersError,
} from "@/domains/understanding/check";
import { RequestKeyTakenError } from "@/domains/understanding/explainers";
import { problemResponse } from "@/lib/problems";

/** The understanding domain's typed failures as problem responses; anything else is a real error and rethrows. */
export function understandingProblem(error: unknown): Response {
  if (error instanceof KeyHasNoOwnerError) return problemResponse(403, "forbidden", error.message);
  if (error instanceof ExplainerNotFoundError) return problemResponse(404, "not_found", error.message);
  if (error instanceof ExplainerNotReadyError) return problemResponse(409, "not_ready", error.message);
  if (error instanceof InvalidCheckAnswersError) return problemResponse(422, "invalid_input", error.message);
  if (error instanceof RequestKeyTakenError) return problemResponse(409, "conflict", error.message);
  throw error;
}
