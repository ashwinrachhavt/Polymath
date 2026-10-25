import { z } from "zod";
import { recordAudit } from "@/domains/audit/record";
import type { AuthContext } from "@/domains/identity/resolve";
import { withTransaction } from "@/lib/db-transaction";
import { untrustedDataClauseJsonSafe } from "@/lib/prompts";
import {
  GenerationUnconfiguredError,
  generationProvider,
  type GenerationProvider,
} from "@/integrations/generation/provider";
import { searchDocumentsForAgent } from "./agent-search";
import { createNoteInTx } from "./notes";

/*
 * Library-grounded long-form writing (ASH-302's sibling, ASH-301): the
 * co-pilot drafts only from what the owner's library actually contains.
 * Every borrowed claim carries a [n] citation into the source list, and any
 * paragraph the sources do not support is flagged [citation needed] rather
 * than smoothed over. A library with nothing on the topic is an honest
 * refusal, never an invented draft.
 *
 * Citations are validated as DATA before anything is written: a citation
 * index outside the retrieved source list is the model inventing a source,
 * and the whole answer is unusable.
 */

export class LibraryEmptyError extends Error {
  constructor(topic: string) {
    super(`The library has nothing on "${topic}" yet. Capture sources first - the co-pilot only writes from what is there.`);
    this.name = "LibraryEmptyError";
  }
}

export class WritingUnusableAnswerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WritingUnusableAnswerError";
  }
}

export const WRITING_MAX_SOURCES = 8;
export const WRITING_MAX_PARAGRAPHS = 20;
export const WRITING_MAX_SOURCE_CHARS = 1_500;

const response = z.object({
  title: z.string().trim().min(1).max(200),
  paragraphs: z
    .array(
      z.object({
        text: z.string().trim().min(1).max(2_000),
        /** 1-based indexes into the retrieved source list. */
        citations: z.array(z.number().int().min(1)).max(WRITING_MAX_SOURCES),
        /** True when the paragraph makes a claim the sources do not support. */
        needsCitation: z.boolean(),
      }),
    )
    .min(1)
    .max(WRITING_MAX_PARAGRAPHS),
});

export type LibraryDraft = z.infer<typeof response>;

const SYSTEM = `You draft long-form writing for the owner using ONLY the numbered library sources below. Return JSON with exactly these keys: {"title": string, "paragraphs": [{"text": string, "citations": number[], "needsCitation": boolean}]}.
Every claim a source supports carries that source's number in "citations" (1-based, into the list given). A paragraph that says something the sources do NOT support sets "needsCitation": true instead of borrowing authority it does not have - the owner would rather see the gap than trust a guess. Never cite a source number you were not given. ${untrustedDataClauseJsonSafe("library sources")} Write only what the sources carry.`;

export type LibrarySource = { documentId: string; title: string; text: string };

export type LibraryWritingDeps = {
  provider?: GenerationProvider;
  search?: (auth: AuthContext, topic: string) => Promise<LibrarySource[]>;
};

async function defaultSearch(auth: AuthContext, topic: string): Promise<LibrarySource[]> {
  const result = await searchDocumentsForAgent(auth, { query: topic, limit: WRITING_MAX_SOURCES });
  if (!result.ok) return [];
  return result.results.map((r) => ({ documentId: r.documentId, title: r.title, text: r.text }));
}

/** Parse the model's JSON strictly, then validate every citation index against the retrieved sources. */
export function parseLibraryDraft(text: string, sourceCount: number): LibraryDraft {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new WritingUnusableAnswerError("The model's answer was not JSON.");
  }
  const parsed = response.safeParse(raw);
  if (!parsed.success) {
    throw new WritingUnusableAnswerError("The model's answer did not match the draft shape.");
  }
  for (const paragraph of parsed.data.paragraphs) {
    for (const citation of paragraph.citations) {
      if (citation > sourceCount) {
        throw new WritingUnusableAnswerError(`The model cited source ${citation}, which was never retrieved.`);
      }
    }
    if (paragraph.needsCitation && paragraph.citations.length > 0) {
      throw new WritingUnusableAnswerError("A paragraph cannot both cite sources and ask for a citation.");
    }
  }
  return parsed.data;
}

function render(draft: LibraryDraft, sources: LibrarySource[]): string {
  const md: string[] = [];
  md.push(`# ${draft.title}`);
  md.push("");
  md.push("*Drafted from the library only. Paragraphs marked [citation needed] make claims the sources do not support.*");
  md.push("");
  for (const paragraph of draft.paragraphs) {
    const cites = paragraph.citations.map((n) => `[${n}]`).join("");
    md.push(`${paragraph.text}${cites ? ` ${cites}` : ""}${paragraph.needsCitation ? " **[citation needed]**" : ""}`);
    md.push("");
  }
  md.push("## Sources");
  sources.forEach((source, i) => md.push(`[${i + 1}] ${source.title}`));
  return md.join("\n");
}

export type LibraryWritingResult = {
  artifactId: string;
  sourceCount: number;
  flaggedCount: number;
};

export async function draftFromLibrary(
  auth: AuthContext,
  input: { topic: string; guidance?: string },
  deps?: LibraryWritingDeps,
): Promise<LibraryWritingResult> {
  const topic = input.topic.trim();
  if (!topic) throw new WritingUnusableAnswerError("Name what the draft is about.");

  const search = deps?.search ?? defaultSearch;
  const sources = (await search(auth, topic)).slice(0, WRITING_MAX_SOURCES);
  if (sources.length === 0) throw new LibraryEmptyError(topic);

  let provider: GenerationProvider;
  try {
    provider = deps?.provider ?? generationProvider(process.env);
  } catch (error) {
    if (error instanceof GenerationUnconfiguredError) throw new WritingUnusableAnswerError(error.message);
    throw error;
  }

  const sourceList = sources
    .map((s, i) => `[${i + 1}] "${s.title}": ${s.text.slice(0, WRITING_MAX_SOURCE_CHARS)}`)
    .join("\n\n");
  const prompt = `TOPIC: ${topic}${input.guidance ? `\nGUIDANCE: ${input.guidance}` : ""}\n\nSOURCES:\n${sourceList}`;
  const out = await provider.generate({ system: SYSTEM, prompt, json: true });
  const draft = parseLibraryDraft(out.text, sources.length);
  const markdown = render(draft, sources);
  const flaggedCount = draft.paragraphs.filter((p) => p.needsCitation).length;

  const artifactId = await withTransaction(async (tx) => {
    const note = await createNoteInTx(tx, auth, {
      title: draft.title,
      kind: "document",
      plainText: markdown,
    });
    await recordAudit(
      auth,
      {
        action: "writing.library_drafted",
        subjectType: "artifact",
        subjectId: note.id,
        summary: `Drafted "${draft.title}" from ${sources.length} library source${sources.length === 1 ? "" : "s"} (${flaggedCount} flagged).`,
        metadata: {
          topic,
          sourceIds: sources.map((s) => s.documentId),
          flaggedCount,
          proposer: provider.name,
        },
      },
      tx,
    );
    return note.id;
  });

  return { artifactId, sourceCount: sources.length, flaggedCount };
}
