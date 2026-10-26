import { supportsEffect } from "@/domains/actions/executor";
import { LOCAL_WRITERS } from "./local-writes";

/*
 * Approval scope for the review card: the "approving records the decision
 * only" caveat is true only when approval can run NO effect - no provider
 * executor and no local write. Both registries are the same sources the
 * approval path executes, so the caveat cannot drift from the behavior.
 */
export function decisionOnlyFor(capability: string): boolean {
  return !supportsEffect(capability) && !Object.prototype.hasOwnProperty.call(LOCAL_WRITERS, capability);
}
