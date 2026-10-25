import { z } from "zod";

/*
 * The onboarding brief: what the interview run's final turn emits and what the
 * confirm card edits before anything is written.
 *
 * The payload rides the existing `message` run event's data content — the
 * agent closes its last reply with a fenced `onboarding-brief` JSON block —
 * rather than a new event type, because the bridge already persists assistant
 * text verbatim and a second channel would give the card two sources to
 * disagree. Extraction therefore lives here as a pure function over thread
 * text: no database, no network, unit-testable, and shared by the server read
 * path and the fallback pre-fill.
 */

export const ONBOARDING_BRIEF_FENCE = "```onboarding-brief";

export const onboardingBriefSchema = z.object({
  role: z.string().trim().min(1).max(200),
  tools: z.array(z.string().trim().min(1).max(80)).max(30),
  priorities: z.array(z.string().trim().min(1).max(200)).max(20),
  agentName: z.string().trim().min(1).max(60),
});

export type OnboardingBrief = z.infer<typeof onboardingBriefSchema>;

/**
 * The last complete `onboarding-brief` fence in a thread text, Zod-validated.
 * Last-wins: an agent that revised its closing summary leaves both blocks in
 * the transcript, and the final one is the brief. Anything unparseable —
 * truncated JSON, wrong shape, no fence — is null, never a partial brief:
 * the caller routes to the pre-filled form instead of guessing.
 */
export function extractOnboardingBrief(threadText: string): OnboardingBrief | null {
  const raw = lastFenceBody(threadText);
  if (raw === null) return null;
  try {
    const parsed = onboardingBriefSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * Best-effort field salvage for the extraction-failure form. Unlike
 * extractOnboardingBrief this keeps what it can: a fence whose JSON parses but
 * fails the schema still tells us the role the agent heard. Plain prose yields
 * nothing — inventing fields from chat text is exactly the guess the fallback
 * form exists to let the person correct.
 */
export function prefillOnboardingFromThread(threadText: string): Partial<OnboardingBrief> {
  const raw = lastFenceBody(threadText);
  if (raw === null) return {};
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return {};
  }
  if (typeof value !== "object" || value === null) return {};
  const record = value as Record<string, unknown>;
  const out: Partial<OnboardingBrief> = {};
  if (typeof record.role === "string" && record.role.trim()) out.role = record.role.trim().slice(0, 200);
  if (typeof record.agentName === "string" && record.agentName.trim()) {
    out.agentName = record.agentName.trim().slice(0, 60);
  }
  const strings = (entry: unknown): string[] | null => {
    if (Array.isArray(entry)) {
      const list = entry.filter((item): item is string => typeof item === "string" && item.trim() !== "");
      return list.length > 0 ? list.map((item) => item.trim()) : null;
    }
    // A model that wrote "Notion, Gmail" instead of an array still meant tools.
    if (typeof entry === "string" && entry.trim()) {
      return entry.split(/[,\n;]/).map((item) => item.trim()).filter(Boolean);
    }
    return null;
  };
  const tools = strings(record.tools);
  if (tools) out.tools = tools.slice(0, 30);
  const priorities = strings(record.priorities);
  if (priorities) out.priorities = priorities.slice(0, 20);
  return out;
}

/** Body of the last closed onboarding-brief fence, or null when there is none. */
function lastFenceBody(text: string): string | null {
  let found: string | null = null;
  let at = 0;
  for (;;) {
    const open = text.indexOf(ONBOARDING_BRIEF_FENCE, at);
    if (open === -1) break;
    const bodyStart = open + ONBOARDING_BRIEF_FENCE.length;
    const close = text.indexOf("```", bodyStart);
    if (close === -1) break; // unclosed trailing fence: the turn is still streaming
    found = text.slice(bodyStart, close).trim();
    at = close + 3;
  }
  return found;
}
