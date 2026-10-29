import { createHash } from "node:crypto";
import { z } from "zod";
import type { AuthContext } from "@/domains/identity/resolve";
import { untrustedDataClauseJsonSafe } from "@/lib/prompts";
import {
  GenerationRequestError,
  GenerationUnconfiguredError,
  generationProvider,
  type GenerationProvider,
} from "@/integrations/generation/provider";
import { providerEntry } from "@/integrations/providers/registry";
import { drizzleQuotaStore, withQuota, type QuotaStore } from "@/integrations/providers/quota";
import { createTask } from "@/domains/work/commands";
import { createNote } from "./notes";
import { DECOMPOSE_MAX_CHARS, SittingError } from "./sittings";

/*
 * Decomposition (plan §4): a proposal-generating compiler. A paste over
 * DECOMPOSE_PASTE_CHARS triggers analysis; over DECOMPOSE_MAX_CHARS it is
 * REJECTED, never truncated (§15.1 - silent truncation would violate the
 * surfaced-omissions invariant). One JSON call, schema-validated, and
 * commit-nothing-on-failure: analysis writes nothing, and a failed analysis
 * throws before any proposal exists.
 *
 * The invariants are the extractor's, extended: no invented quotes (every
 * candidate's quotes are re-located verbatim in the source; an unlocatable
 * quote drops the candidate), multiple passages may support one candidate,
 * omitted material is surfaced with its reason, extraction and synthesis are
 * distinguished, and roles route destinations (principle -> zettel; decision
 * record -> note; checklist -> task, never a zettel).
 */

export type DecompositionRole = "principle" | "decision" | "checklist";
export type DecompositionSpan = { start: number; end: number; quote: string };
export type DecompositionCandidate = {
  /** Dedupe key: source hash + span (§4). Stable across re-analysis of the same paste. */
  id: string;
  role: DecompositionRole;
  kind: "extraction" | "synthesis";
  title: string;
  content: string;
  spans: DecompositionSpan[];
};
export type DecompositionAnalysis = {
  candidates: DecompositionCandidate[];
  /** Material the pass consciously left out, with the model's reason. */
  omitted: { quote: string; reason: string }[];
  sourceHash: string;
};

export const PASTE_TOO_LONG = "Paste is too long to analyze at once — split it or select a section.";
export const pasteTooLong = () => new SittingError("PASTE_TOO_LONG", PASTE_TOO_LONG);

export const sourceHash = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 16);

/** The verbatim-locate (§4): a quote that is not really in the source is dropped, never trusted. */
export function locateSpan(text: string, quote: string): DecompositionSpan | null {
  const start = text.indexOf(quote);
  if (start < 0) return null;
  return { start, end: start + quote.length, quote };
}

const responseSchema = z.object({
  candidates: z.array(
    z.object({
      role: z.enum(["principle", "decision", "checklist"]),
      kind: z.enum(["extraction", "synthesis"]),
      title: z.string().min(1).max(160),
      content: z.string().min(1),
      quotes: z.array(z.string().min(1)).min(1),
    }),
  ),
  omitted: z.array(z.object({ quote: z.string().min(1), reason: z.string().min(1) })).default([]),
});

const SYSTEM = `You decompose a pasted text into its intellectual structure. Return JSON with exactly this shape: {"candidates":[{"role","kind","title","content","quotes"}],"omitted":[{"quote","reason"}]}.
"role": "principle" for a principle or claim (becomes a zettel), "decision" for a decision record (becomes a linked note), "checklist" for actionable steps (becomes a task, never a zettel).
"kind": "extraction" when the content restates what the text says, "synthesis" when it draws a conclusion the text supports but does not state.
"content": one atomic statement, preserving the text's qualifiers, negations and attribution exactly.
"quotes": the passages supporting this candidate, copied VERBATIM from the text - one candidate may rest on several passages. Never paraphrase, never reconstruct from memory; if you cannot quote support, drop the candidate.
"omitted": passages you consciously did not turn into candidates, each with a one-line reason.
Return {"candidates":[],"omitted":[]} when the text has no decomposable structure. ${untrustedDataClauseJsonSafe("text")}`;

export interface PasteDecomposer {
  readonly name: string;
  decompose(text: string): Promise<z.infer<typeof responseSchema>>;
}

function fromGeneration(provider: GenerationProvider, run: (input: { system: string; prompt: string }) => Promise<{ text: string }>): PasteDecomposer {
  return {
    name: provider.name,
    async decompose(text) {
      let out: { text: string };
      try {
        out = await run({ system: SYSTEM, prompt: text });
      } catch (cause) {
        if (cause instanceof GenerationRequestError) {
          throw new SittingError("DECOMPOSE_PROVIDER_FAILED", `Decomposition failed (HTTP ${cause.status}).`);
        }
        throw cause;
      }
      try {
        return responseSchema.parse(JSON.parse(out.text));
      } catch {
        throw new SittingError("DECOMPOSE_BAD_RESPONSE", "Decomposition returned an unreadable answer.");
      }
    },
  };
}

/** The seam-wired decomposer: the resolved generation provider under the workspace's quota (same contract as the zettel extractor). */
export function defaultPasteDecomposer(
  workspaceId?: string,
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch,
  quotaStore?: QuotaStore,
): PasteDecomposer {
  let provider: GenerationProvider;
  try {
    provider = generationProvider(env, fetchImpl);
  } catch (cause) {
    if (cause instanceof GenerationUnconfiguredError) {
      throw new SittingError("DECOMPOSE_UNCONFIGURED", "No generation provider is configured.");
    }
    throw cause;
  }
  const entry = providerEntry(provider.registryId);
  return fromGeneration(provider, (input) => {
    const call = () => provider.generate({ ...input, json: true });
    if (workspaceId && entry?.quota && entry.enabled) {
      return withQuota(quotaStore ?? drizzleQuotaStore(), entry, workspaceId, 1, call);
    }
    return call();
  });
}

/*
 * Analysis writes nothing. Over-cap input is rejected before the model call;
 * unlocatable quotes drop their candidate; omitted passages are re-located
 * the same way so the "omitted" list can never invent content either.
 */
export function analyzePaste(text: string, raw: z.infer<typeof responseSchema>): DecompositionAnalysis {
  if (text.length > DECOMPOSE_MAX_CHARS) throw pasteTooLong();
  const hash = sourceHash(text);
  const candidates: DecompositionCandidate[] = [];
  for (const candidate of raw.candidates) {
    const spans = candidate.quotes.map((q) => locateSpan(text, q)).filter((s): s is DecompositionSpan => s !== null);
    if (spans.length === 0) continue; // no verbatim support: no proposal
    const first = spans[0];
    const id = createHash("sha256").update(`${hash}:${first.start}:${first.end}:${candidate.title}`).digest("hex").slice(0, 24);
    candidates.push({ id, role: candidate.role, kind: candidate.kind, title: candidate.title, content: candidate.content, spans });
  }
  const omitted = raw.omitted
    .map((o) => ({ ...o, span: locateSpan(text, o.quote) }))
    .filter((o) => o.span !== null)
    .map(({ quote, reason }) => ({ quote, reason }));
  return { candidates, omitted, sourceHash: hash };
}

/** Full analysis through the decomposer: validates the cap, then the schema, then the verbatim locate. */
export async function decomposePaste(auth: AuthContext, text: string, decomposer?: PasteDecomposer): Promise<DecompositionAnalysis> {
  if (text.length > DECOMPOSE_MAX_CHARS) throw pasteTooLong();
  const raw = await (decomposer ?? defaultPasteDecomposer(auth.workspaceId)).decompose(text);
  return analyzePaste(text, raw);
}

export type DecompositionDecision =
  | { candidateId: string; action: "skip" }
  | { candidateId: string; action: "create" };

/*
 * The batch commit (§4): each accepted candidate becomes its routed
 * destination, and the idempotency key rides the dedupe id (document/source
 * + span) so a retried batch creates one card per span, never two. Merging
 * into an existing card and link-only decisions are the review UI's next
 * slice; only create and skip are committed here.
 */
export async function commitDecomposition(
  auth: AuthContext,
  input: { analysis: DecompositionAnalysis; decisions: DecompositionDecision[]; idempotencyKey: string },
): Promise<{ created: { candidateId: string; destination: "zettel" | "note" | "task"; id: string }[]; skipped: string[] }> {
  const created: { candidateId: string; destination: "zettel" | "note" | "task"; id: string }[] = [];
  const skipped: string[] = [];
  for (const decision of input.decisions) {
    const candidate = input.analysis.candidates.find((c) => c.id === decision.candidateId);
    if (!candidate) continue;
    if (decision.action === "skip") {
      skipped.push(candidate.id);
      continue;
    }
    const key = `${input.idempotencyKey}:${candidate.id}`;
    const body = `${candidate.content}\n\n> ${candidate.spans.map((s) => s.quote).join("\n>\n> ")}`;
    if (candidate.role === "checklist") {
      const task = await createTask(auth, { title: candidate.title, description: body, tags: ["decomposed"] });
      created.push({ candidateId: candidate.id, destination: "task", id: task.id });
    } else if (candidate.role === "decision") {
      const note = await createNote(auth, {
        idempotencyKey: key,
        title: candidate.title,
        content: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: body }] }] },
        plainText: body,
        kind: "note",
      });
      created.push({ candidateId: candidate.id, destination: "note", id: note.id });
    } else {
      const note = await createNote(auth, {
        idempotencyKey: key,
        title: candidate.title,
        content: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: body }] }] },
        plainText: body,
        kind: "zettel",
      });
      created.push({ candidateId: candidate.id, destination: "zettel", id: note.id });
    }
  }
  return { created, skipped };
}
