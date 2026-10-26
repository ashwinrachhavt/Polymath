/*
 * Pure, client-safe mirror of the enable-side gates in sender-sync.ts
 * setSenderProposals, so the Connectors card can show why enabling is
 * unavailable instead of letting the owner flip a switch that must fail.
 * Disable never gates: stopping the pass must not depend on access the
 * owner may already have taken away.
 */
import { capabilityAllowed, lowestTierId } from "@/domains/integrations/capabilities";

export type SenderProposalsBlock = "disconnected" | "read_off" | null;

export function senderProposalsBlockedReason(account: {
  status: string;
  allowRead: boolean;
  accessTier: string | null;
  disabledCapabilities: string[];
}): SenderProposalsBlock {
  if (account.status !== "active") return "disconnected";
  const tier = account.accessTier ?? lowestTierId("gmail");
  if (!account.allowRead || !tier || !capabilityAllowed("gmail", tier, account.disabledCapabilities, "gmail.read")) return "read_off";
  return null;
}
