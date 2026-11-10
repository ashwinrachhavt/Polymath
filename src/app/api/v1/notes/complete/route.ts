import { z } from "zod";
import { authedHandler } from "@/lib/auth";
import { requireRole, requireScope } from "@/lib/auth/guards";
import { problemResponse } from "@/lib/problems";
import { completeWriting } from "@/domains/knowledge/writing-completion";
import { GenerationUnconfiguredError } from "@/integrations/generation/provider";
import { QuotaExhaustedError } from "@/integrations/providers/quota";

/*
 * POST /api/v1/notes/complete - the next few words at the cursor, for the note
 * editor's inline autocomplete. A route rather than a server action because
 * the editor cancels a request the moment the writer types again, and server
 * actions queue and cannot be aborted.
 *
 * It answers 200 with `completion: ""` whenever there is nothing to show
 * (too little text, a slow or failed provider, a reply that was not a
 * continuation): a missing suggestion is not an error the writer should see.
 * `answered: false` marks the empties where the model gave no reply at all (it
 * failed, timed out or sent no text), so the editor can say suggestions are
 * not arriving instead of claiming they are on. 503 (no provider configured)
 * and 429 (allowance or rate) tell the editor to stop asking for a while.
 */

const completeRequest = z.object({
  title: z.string().max(500).optional(),
  before: z.string().max(20_000),
  after: z.string().max(5_000).optional(),
});

// Per-process brake on one person's requests. The editor debounces and
// cancels; this bounds a client that does neither.
const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 40;
const recent = new Map<string, number[]>();

function admitted(userId: string, now = Date.now()): boolean {
  const calls = (recent.get(userId) ?? []).filter((at) => now - at < WINDOW_MS);
  if (calls.length >= MAX_PER_WINDOW) {
    recent.set(userId, calls);
    return false;
  }
  calls.push(now);
  recent.set(userId, calls);
  if (recent.size > 5_000) for (const [id, at] of recent) if (!at.some((t) => now - t < WINDOW_MS)) recent.delete(id);
  return true;
}

export const POST = authedHandler(async (auth, request) => {
  requireRole(auth, "member");
  // The editor's own session only: no API key carries this scope.
  requireScope(auth, "notes:autocomplete");
  const parsed = completeRequest.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return problemResponse(422, "invalid_input", "Send the text before the cursor.");
  if (!admitted(auth.userId))
    return problemResponse(429, "rate_limited", "Too many suggestions requested; try again shortly.");

  try {
    const { completion, answered } = await completeWriting(auth, parsed.data, { signal: request.signal });
    return Response.json(answered ? { completion } : { completion, answered }, {
      headers: { "cache-control": "no-store" },
    });
  } catch (cause) {
    if (cause instanceof GenerationUnconfiguredError) {
      return problemResponse(503, "generation_unconfigured", "No model provider is configured for suggestions.");
    }
    if (cause instanceof QuotaExhaustedError) {
      return problemResponse(429, "quota_exhausted", "The model allowance for suggestions is used up.");
    }
    // A timeout, an aborted request or a provider error: no suggestion.
    return Response.json({ completion: "", answered: false }, { headers: { "cache-control": "no-store" } });
  }
});
