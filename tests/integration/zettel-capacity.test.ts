import { drizzle } from "drizzle-orm/postgres-js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { artifactVersions, artifacts } from "@/domains/knowledge/schema";
import { eq } from "drizzle-orm";
import { makeTestDb, ownerAuth, seedWorkspace } from "../helpers/test-workspace";

/*
 * The size-derived proposal cap (capForSize) at its four seams: the extractor
 * prompt asks for at most N, the response schema enforces N, the merge keeps
 * at most N, and the final slice cuts at N — one cap per pass, computed once
 * from the resolved source text.
 */

const handle = makeTestDb();
const suite = handle ? describe : describe.skip;
const holder: { db: ReturnType<typeof drizzle> | undefined } = { db: undefined };
vi.mock("@/lib/db", () => ({
  get db() {
    return holder.db;
  },
}));
vi.mock("@/lib/db-transaction", () => ({
  get withTransaction() {
    return (fn: Parameters<typeof import("@/lib/db-transaction").withTransaction>[0]) =>
      (holder.db!.transaction as typeof import("@/lib/db-transaction").withTransaction)(fn);
  },
}));

// The generation provider is driven per test: the real extractor (seams 1-2)
// and the merge pass (seam 3) both reach it through this seam.
const gen = vi.hoisted(() => ({
  generate: undefined as
    undefined | ((input: { system?: string; prompt: string; json?: boolean }) => Promise<{ text: string }>),
}));
vi.mock("@/integrations/generation/provider", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/integrations/generation/provider")>();
  return {
    ...actual,
    generationProvider: () => ({
      name: "fake:gen",
      registryId: "fake",
      generate: (input: { system?: string; prompt: string; json?: boolean }) => gen.generate!(input),
    }),
  };
});

beforeAll(() => {
  holder.db = handle?.db;
  // Keep every best-effort dedup read unconfigured: the pass degrades to
  // unflagged proposals instead of reaching for a real provider.
  vi.stubEnv("OPENAI_API_KEY", "");
  vi.stubEnv("OPENROUTER_API_KEY", "");
  vi.stubEnv("GEMINI_API_KEY", "");
});
afterAll(async () => {
  vi.unstubAllEnvs();
  await handle?.client.end();
});

/** Seeds a workspace whose note-kind artifact carries `text` as its current version. */
async function seedTextArtifact(label: string, text: string) {
  const db = holder.db!;
  const seed = await seedWorkspace(db, `zcap-${label}-${Date.now()}`);
  const auth = ownerAuth(seed.userId, seed.workspaceId);
  const [artifact] = await db
    .insert(artifacts)
    .values({
      workspaceId: auth.workspaceId,
      kind: "note",
      title: "Source notes",
      createdBy: auth.userId,
      updatedBy: auth.userId,
    })
    .returning({ id: artifacts.id, version: artifacts.version });
  const [version] = await db
    .insert(artifactVersions)
    .values({
      workspaceId: auth.workspaceId,
      artifactId: artifact.id,
      versionNumber: 1,
      content: { format: "markdown", text },
      plainText: text,
      reason: "created",
      createdBy: auth.userId,
    })
    .returning({ id: artifactVersions.id });
  await db.update(artifacts).set({ currentVersionId: version.id }).where(eq(artifacts.id, artifact.id));
  return { auth, artifactId: artifact.id };
}

const sentence = (i: number) => `Claim sentence number ${i} stands here in its own words.`;

suite("the size-derived proposal cap (real Postgres)", () => {
  it("caps a small single-section source at 2 (the final-slice seam), computed once", async () => {
    const text = Array.from({ length: 6 }, (_, i) => sentence(i)).join(" ");
    expect(text.length).toBeLessThanOrEqual(2_000);
    const { auth, artifactId } = await seedTextArtifact("small", text);
    const { proposeZettels } = await import("@/domains/knowledge/zettels");

    const seen: Array<{ chars: number; max: number | undefined }> = [];
    const extractor = {
      name: "fake",
      extract: async (section: string, options?: { max?: number }) => {
        seen.push({ chars: section.length, max: options?.max });
        return Array.from({ length: 6 }, (_, i) => ({ title: `T${i}`, claim: `Claim ${i}`, quote: sentence(i) }));
      },
    };
    const { proposals } = await proposeZettels(auth, { sourceArtifactId: artifactId, extractor });
    expect(proposals).toHaveLength(2);
    // One cap for the whole pass: the single section call carried it.
    expect(seen).toEqual([{ chars: text.length, max: 2 }]);
  });

  it("enforces the cap at the extractor: prompt asks for N and the schema rejects over-returning", async () => {
    const filler = Array.from({ length: 120 }, () => "Filler prose to push the source into the medium band.").join(" ");
    const text = `${filler} ${sentence(1)}`;
    expect(text.length).toBeGreaterThan(2_000);
    expect(text.length).toBeLessThanOrEqual(12_000);
    const { auth, artifactId } = await seedTextArtifact("medium-real", text);
    const { proposeZettels } = await import("@/domains/knowledge/zettels");

    const systems: string[] = [];
    gen.generate = async (input) => {
      if (input.system) systems.push(input.system);
      return {
        text: JSON.stringify({
          zettels: Array.from({ length: 8 }, (_, i) => ({ title: `T${i}`, claim: `Claim ${i}`, quote: sentence(1) })),
        }),
      };
    };
    // The real extractor (no input.extractor): 8 candidates against a cap of 5
    // must fail the parse — the cap is enforced, not asked — and the pass
    // throws so the dispatcher retries.
    await expect(proposeZettels(auth, { sourceArtifactId: artifactId })).rejects.toThrow("unreadable");
    expect(systems[0]).toContain("Return at most 5");
  });

  it("caps a chunked medium source at 5 through the merge seam and the final slice", async () => {
    const filler = Array.from({ length: 70 }, () => "Filler prose for the section body.").join(" ");
    const text = `${filler} ${sentence(1)} ${sentence(2)} ${sentence(3)} ${sentence(4)}\n## Part 2\n${filler} ${sentence(5)} ${sentence(6)} ${sentence(7)} ${sentence(8)}`;
    expect(text.length).toBeGreaterThan(2_000);
    expect(text.length).toBeLessThanOrEqual(12_000);
    const { auth, artifactId } = await seedTextArtifact("medium-chunked", text);
    const { proposeZettels } = await import("@/domains/knowledge/zettels");

    const seenMax: Array<number | undefined> = [];
    const extractor = {
      name: "fake",
      extract: async (section: string, options?: { max?: number }) => {
        seenMax.push(options?.max);
        // Quote whichever section actually arrived: verbatim location is per-section.
        const base = section.includes("Part 2") ? 5 : 1;
        return [0, 1, 2, 3].map((k) => ({
          title: `T${base + k}`,
          claim: `Claim ${base + k}`,
          quote: sentence(base + k),
        }));
      },
    };
    // The merge model answers with more indices than the cap; its own keep
    // loop (max) and the final slice both read the same size-derived number.
    const mergeSystems: string[] = [];
    gen.generate = async (input) => {
      if (input.system) mergeSystems.push(input.system);
      return { text: JSON.stringify({ keep: [0, 1, 2, 3, 4, 5, 6, 7] }) };
    };
    const { proposals } = await proposeZettels(auth, { sourceArtifactId: artifactId, extractor });
    expect(proposals).toHaveLength(5);
    // The cap was computed once from the resolved source text: both section
    // calls carried the same 5.
    expect(seenMax).toEqual([5, 5]);
    expect(mergeSystems[0]).toContain("keep at most 5");
  });
});
