import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { auditEvents } from "@/domains/audit/schema";
import { makeTestDb, seedWorkspace } from "../helpers/test-workspace";

/*
 * Value: protects=the dictation route's door and contract on real Postgres: signed-in members only,
 * companion API keys and machine contexts refused before any provider call, the bytes sniffed (not
 * the client's content-type), oversized and non-audio clips refused, a success answering the
 * fixture's words and writing one audit row that holds no words; fails_when=an API key can spend the
 * transcription allowance, a text file is sent to the provider because it was labelled audio, a 5 MB
 * body is buffered and transcribed, or the transcript lands in the audit log; why_new=the route is
 * new; seam=Clerk mocked, the companion bearer path and the database real, TRANSCRIPTION_PROVIDER=fixture;
 * no_claim=Deepgram (unit tests cover the quota and failure outcomes)
 */

const handle = makeTestDb();
const suite = handle ? describe : describe.skip;

const holder = vi.hoisted(() => ({
  db: undefined as unknown,
  session: true,
  auth: undefined as undefined | { userId: string; workspaceId: string; role: string; scopes?: string[] },
}));

vi.mock("@/lib/db", () => ({
  get db() {
    return holder.db;
  },
}));
vi.mock("@/lib/clerk", () => ({ clerkConfigured: true, devAuthBypass: false }));
vi.mock("@clerk/nextjs/server", () => ({
  auth: vi.fn(async () =>
    holder.session ? { isAuthenticated: true, userId: "clerk_test" } : { isAuthenticated: false },
  ),
}));
vi.mock("@/domains/identity/resolve", () => ({ resolveAuthContext: vi.fn(async () => holder.auth) }));

import { POST } from "@/app/api/v1/speech/transcriptions/route";
import { mintApiClient } from "@/domains/identity/machine";
import { FIXTURE_TRANSCRIPT } from "@/integrations/transcription/fixture";

const WEBM = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 0x01, 0x42, 0xf7, 0x81]);

const post = (body: BodyInit, headers: Record<string, string> = {}) =>
  POST(new Request("https://axiom.dev/api/v1/speech/transcriptions", { method: "POST", body, headers }), undefined);

let workspace: { userId: string; workspaceId: string };

beforeAll(async () => {
  vi.stubEnv("TRANSCRIPTION_PROVIDER", "fixture");
  if (!handle) return;
  holder.db = handle.db;
  workspace = await seedWorkspace(handle.db, `speech-route-${crypto.randomUUID().slice(0, 8)}`);
});

beforeEach(() => {
  holder.session = true;
  holder.auth = workspace && { ...workspace, role: "member" };
});

afterAll(async () => {
  vi.unstubAllEnvs();
  await handle?.client.end();
});

const dictationAudits = () =>
  handle!.db
    .select()
    .from(auditEvents)
    .where(and(eq(auditEvents.workspaceId, workspace.workspaceId), eq(auditEvents.subjectType, "dictation")));

suite("POST /api/v1/speech/transcriptions", () => {
  it("refuses a request with no session", async () => {
    holder.session = false;
    const res = await post(WEBM, { "content-type": "audio/webm" });
    expect(res.status).toBe(401);
  });

  it("refuses a companion API key, even one holding every grantable scope", async () => {
    const { token } = await mintApiClient({
      workspaceId: workspace.workspaceId,
      name: "speech route test key",
      kind: "companion",
      scopes: ["captures:read", "captures:write", "focus:read"],
    });
    const res = await post(WEBM, { "content-type": "audio/webm", authorization: `Bearer ${token}` });
    expect(res.status).toBe(403);
  });

  it("refuses a machine context resolved from a Clerk machine token", async () => {
    holder.auth = { ...workspace, role: "owner", scopes: ["captures:write"] };
    expect((await post(WEBM, { "content-type": "audio/webm" })).status).toBe(403);
  });

  it("refuses a viewer", async () => {
    holder.auth = { ...workspace, role: "viewer" };
    expect((await post(WEBM, { "content-type": "audio/webm" })).status).toBe(403);
  });

  it("refuses text labelled as audio", async () => {
    const res = await post(new TextEncoder().encode("this is not audio at all"), { "content-type": "audio/webm" });
    expect(res.status).toBe(415);
    expect((await res.json()).code).toBe("unsupported_media_type");
  });

  it("refuses an image", async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d]);
    expect((await post(png, { "content-type": "audio/webm" })).status).toBe(415);
  });

  it("refuses a clip over 4 MB", async () => {
    const big = new Uint8Array(4 * 1024 * 1024 + 1);
    big.set(WEBM);
    const res = await post(big, { "content-type": "audio/webm" });
    expect(res.status).toBe(413);
  });

  it("refuses an empty body", async () => {
    expect((await post(new Uint8Array(0))).status).toBe(400);
  });

  it("answers the words for a member's clip and audits the attempt without them", async () => {
    const before = (await dictationAudits()).length;
    // The client's label is wrong on purpose: the sniff decides.
    const res = await post(WEBM, { "content-type": "text/plain" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ text: FIXTURE_TRANSCRIPT });
    const rows = await dictationAudits();
    expect(rows).toHaveLength(before + 1);
    const row = rows.at(-1)!;
    expect(row.action).toBe("speech.dictation_transcribed");
    expect(row.actorId).toBe(workspace.userId);
    expect(row.metadata).toMatchObject({ provider: "fixture:transcription", seconds: null });
    expect(JSON.stringify(row)).not.toContain("Priya");
  });
});
