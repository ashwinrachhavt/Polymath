import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { captures } from "@/domains/capture/schema";
import { makeTestDb, seedWorkspace } from "../helpers/test-workspace";

/*
 * The duplicate-URL contract the browser companion switches on: POST
 * /api/v1/captures answers a repeated URL-only capture with 409
 * application/problem+json whose type/code/title/status members stay
 * byte-exact, plus the additive existingCaptureId pointing at the row that
 * is already there. The route runs for real against the scratch database;
 * only Clerk and the db transports are swapped, same as file-intake.test.ts.
 *
 * Skipped unless TEST_DATABASE_URL points at a database with the migrations
 * applied. Fresh unique slugs, no truncation, following the other suites.
 */

const handle = makeTestDb();
const suite = handle ? describe : describe.skip;

const holder: {
  db: ReturnType<typeof drizzle> | undefined;
  auth: { userId: string; workspaceId: string; role: "owner" } | undefined;
} = {
  db: undefined,
  auth: undefined,
};

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
vi.mock("@/lib/clerk", () => ({ clerkConfigured: true, devAuthBypass: false }));
vi.mock("@clerk/nextjs/server", () => ({
  auth: vi.fn(async () => ({ isAuthenticated: true, userId: "clerk_test" })),
}));
vi.mock("@/domains/identity/resolve", () => ({
  resolveAuthContext: vi.fn(async () => holder.auth),
}));

import { POST } from "@/app/api/v1/captures/route";

// The client is the file's, not any one suite's: a suite-scoped end() left
// every suite after the first DB suite seeding against an ended connection.
afterAll(async () => {
  await handle?.client.end();
});

function captureRequest(body: unknown) {
  return new Request("https://axiom.dev/api/v1/captures", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("problemResponse extra members", () => {
  it("additive members can never override the pinned four", async () => {
    const { problemResponse } = await import("@/lib/problems");
    const res = problemResponse(409, "conflict", "That URL is already in the inbox.", {
      existingCaptureId: "capt-1",
      code: "sneaky",
      title: "sneaky",
      type: "sneaky",
      status: 200,
    });
    const body = await res.json();
    expect(body.existingCaptureId).toBe("capt-1");
    expect(body.code).toBe("conflict");
    expect(body.title).toBe("That URL is already in the inbox.");
    expect(body.type).toBe("https://axiom.dev/problems/conflict");
    expect(body.status).toBe(409);
    expect(res.headers.get("content-type")).toContain("application/problem+json");
  });
});

suite("POST /api/v1/captures duplicate contract", () => {
  beforeAll(async () => {
    if (!handle) return;
    holder.db = handle.db;
  });

  it("409 keeps the pinned four members byte-exact and adds existingCaptureId", async () => {
    const { userId, workspaceId } = await seedWorkspace(handle!.db, `capture-route-${Date.now()}`);
    holder.auth = { userId, workspaceId, role: "owner" };
    const url = "https://example.com/companion-contract";

    const first = await POST(captureRequest({ url }), undefined);
    expect(first.status).toBe(201);
    const { capture } = await first.json();

    const dupe = await POST(captureRequest({ url }), undefined);
    expect(dupe.status).toBe(409);
    expect(dupe.headers.get("content-type")).toContain("application/problem+json");
    const body = await dupe.json();
    // The companion recognizes exactly these four members; they must not drift.
    expect(body.type).toBe("https://axiom.dev/problems/conflict");
    expect(body.code).toBe("conflict");
    expect(body.title).toBe("That URL is already in the inbox.");
    expect(body.status).toBe(409);
    // Additive: the capture that is already in the inbox, for "open it" UX.
    expect(body.existingCaptureId).toBe(capture.id);
    expect(Object.keys(body).sort()).toEqual(["code", "existingCaptureId", "status", "title", "type"]);
  });

  it("a different URL in the same workspace still creates", async () => {
    const { userId, workspaceId } = await seedWorkspace(handle!.db, `capture-route-distinct-${Date.now()}`);
    holder.auth = { userId, workspaceId, role: "owner" };
    const res = await POST(captureRequest({ url: "https://example.com/something-new" }), undefined);
    expect(res.status).toBe(201);
    const rows = await holder.db!.select().from(captures).where(eq(captures.workspaceId, workspaceId));
    expect(rows).toHaveLength(1);
  });

  it("records an explicit selection mode", async () => {
    const { userId, workspaceId } = await seedWorkspace(handle!.db, `capture-route-selection-${Date.now()}`);
    holder.auth = { userId, workspaceId, role: "owner" };
    const res = await POST(
      captureRequest({ text: "fragment", url: "https://example.com/s", mode: "selection" }),
      undefined,
    );
    expect(res.status).toBe(201);
    const capture = (await res.json()).capture;
    expect(capture.captureMode).toBe("selection");
  });

  it("treats an address-only body as a url reference", async () => {
    const { userId, workspaceId } = await seedWorkspace(handle!.db, `capture-route-bare-${Date.now()}`);
    holder.auth = { userId, workspaceId, role: "owner" };
    const res = await POST(captureRequest({ url: "https://example.com/bare" }), undefined);
    expect(res.status).toBe(201);
    expect((await res.json()).capture.kind).toBe("url");
  });

  it("still accepts a body with no mode from an older extension", async () => {
    const { userId, workspaceId } = await seedWorkspace(handle!.db, `capture-route-legacy-${Date.now()}`);
    holder.auth = { userId, workspaceId, role: "owner" };
    const res = await POST(captureRequest({ text: "legacy", url: "https://example.com/legacy" }), undefined);
    expect(res.status).toBe(201);
    expect((await res.json()).capture.captureMode).toBe("page");
  });
});

suite("POST /api/v1/captures extension extraction metadata", () => {
  // Its own setup, so a filtered run of one case does not depend on suite order.
  beforeAll(() => {
    holder.db = handle?.db;
  });

  it("keeps the companion's raw_markdown and quality on the capture", async () => {
    const { userId, workspaceId } = await seedWorkspace(handle!.db, `capture-route-markdown-${Date.now()}`);
    holder.auth = { userId, workspaceId, role: "owner" };
    const res = await POST(
      captureRequest({
        text: "A page grab whose formatted reading survives.",
        url: "https://example.com/formatted",
        mode: "page",
        raw_markdown: "# A heading the flatten killed\n\nA paragraph.",
        quality: "rich",
      }),
      undefined,
    );
    expect(res.status).toBe(201);
    const capture = (await res.json()).capture;
    // Provenance on the row, beside the members the payload always had.
    expect(capture.rawPayload.url).toBe("https://example.com/formatted");
    expect(capture.rawPayload.raw_markdown).toBe("# A heading the flatten killed\n\nA paragraph.");
    expect(capture.rawPayload.quality).toBe("rich");
  });

  it("keeps the old raw_payload shape when the body has neither member", async () => {
    const { userId, workspaceId } = await seedWorkspace(handle!.db, `capture-route-nometa-${Date.now()}`);
    holder.auth = { userId, workspaceId, role: "owner" };
    const res = await POST(captureRequest({ text: "Plain words, no extraction." }), undefined);
    expect(res.status).toBe(201);
    const capture = (await res.json()).capture;
    expect(capture.rawPayload).toEqual({ text: "Plain words, no extraction." });
  });

  // Value: protects=companion context lands in raw_payload.context and a bad one is a 422 problem;
  // fails_when=the route stops passing context, stores an invalid field, or loses the words over one; why_new=no route case
  // sent a context; seam=none; no_claim=Clerk mocked; createCapture's own rules are covered elsewhere
  it("stores a companion's capture context beside the words", async () => {
    const { userId, workspaceId } = await seedWorkspace(handle!.db, `capture-route-ctx-${Date.now()}`);
    holder.auth = { userId, workspaceId, role: "owner" };
    const context = {
      source: { kind: "web", title: "An article", url: "https://example.com/a", version: "rev 2" },
      passage: "the exact words",
      surrounding: { before: "Before them,", after: "and after." },
      why: { kind: "unknown" },
    };
    const res = await POST(
      captureRequest({ text: "the exact words", url: "https://example.com/a", context }),
      undefined,
    );
    expect(res.status).toBe(201);
    expect((await res.json()).capture.rawPayload.context).toEqual(context);
  });

  it("saves the capture and names the context fields it had to drop", async () => {
    const { userId, workspaceId } = await seedWorkspace(handle!.db, `capture-route-badctx-${Date.now()}`);
    holder.auth = { userId, workspaceId, role: "owner" };
    const res = await POST(
      captureRequest({
        text: "words that must not be lost",
        context: {
          folder: "inbox",
          source: { url: "javascript:alert(1)" },
          passage: "words that must not be lost",
          why: { kind: "unknown" },
          surrounding: { before: "  " },
        },
      }),
      undefined,
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.contextDropped.sort()).toEqual(["folder", "source"]);
    expect(body.capture.rawPayload.context).toEqual({
      passage: "words that must not be lost",
      why: { kind: "unknown" },
    });
  });
});

suite("POST /api/v1/captures with a YouTube transcript", () => {
  const VIDEO = "dQw4w9WgXcQ";
  const url = `https://www.youtube.com/watch?v=${VIDEO}`;
  const transcript = (videoId = VIDEO) => ({
    videoId,
    title: "A talk",
    language: "en",
    generated: false,
    cues: [{ start: 0, duration: 2, text: "Hello there." }],
  });

  async function jobsOf(workspaceId: string) {
    const { generationJobs } = await import("@/domains/jobs/schema");
    return holder.db!.select().from(generationJobs).where(eq(generationJobs.workspaceId, workspaceId));
  }

  beforeAll(() => {
    if (handle) holder.db = handle.db;
  });

  it("starts the video's job with the transcript the browser read, instead of one to fetch", async () => {
    const { userId, workspaceId } = await seedWorkspace(handle!.db, `capture-route-yt-${Date.now()}`);
    holder.auth = { userId, workspaceId, role: "owner" };
    const res = await POST(captureRequest({ url, mode: "url-reference", youtube_transcript: transcript() }), undefined);
    expect(res.status).toBe(201);
    const [job] = (await jobsOf(workspaceId)).filter((row) => row.kind === "knowledge.youtube");
    expect(job.input).toMatchObject({ videoId: VIDEO, transcript: { cues: [{ text: "Hello there." }] } });
    expect(job.idempotencyKey).toMatch(/:transcript$/);
  });

  it("attaches the transcript to a capture already in the inbox instead of answering 409", async () => {
    const { userId, workspaceId } = await seedWorkspace(handle!.db, `capture-route-yt-dupe-${Date.now()}`);
    holder.auth = { userId, workspaceId, role: "owner" };
    const first = await POST(captureRequest({ url, mode: "url-reference" }), undefined);
    const { capture } = await first.json();
    const second = await POST(
      captureRequest({ url, mode: "url-reference", youtube_transcript: transcript() }),
      undefined,
    );
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({ capture: { id: capture.id }, transcript: "attached" });
    const withTranscript = (await jobsOf(workspaceId)).filter(
      (row) => (row.input as { transcript?: unknown }).transcript,
    );
    expect(withTranscript).toHaveLength(1);
    expect(withTranscript[0].subject).toBe(`capture:${capture.id}`);
  });

  it("refuses a transcript for another video, or one that is too long", async () => {
    const { userId, workspaceId } = await seedWorkspace(handle!.db, `capture-route-yt-bad-${Date.now()}`);
    holder.auth = { userId, workspaceId, role: "owner" };
    const other = await POST(
      captureRequest({ url, mode: "url-reference", youtube_transcript: transcript("aaaaaaaaaaa") }),
      undefined,
    );
    expect(other.status).toBe(422);
    const huge = {
      ...transcript(),
      cues: Array.from({ length: 21_000 }, (_, i) => ({ start: i, duration: 1, text: "x" })),
    };
    expect((await POST(captureRequest({ url, youtube_transcript: huge }), undefined)).status).toBe(422);
    expect(await jobsOf(workspaceId)).toEqual([]);
  });
});
