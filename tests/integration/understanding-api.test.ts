import { drizzle } from "drizzle-orm/postgres-js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { makeTestDb, seedWorkspace } from "../helpers/test-workspace";

/*
 * Value: protects=the HTTP contract the plugin is built on: an API key reaches
 * only the scopes it carries, a malformed request is a 422 not a crash, a
 * repeated request key is one explainer, an unfinished explainer's check is a
 * 409 the agent can wait on, and the preference switches read as off until the
 * person turns them on; fails_when=a key without the scope gets through, a bad
 * body reaches the domain, the second POST makes a second explainer, or a
 * default switch reads as on; seam=the /api/v1/understanding routes with real
 * keys against a real database; no_claim=generation itself (the job is not
 * kicked here) and the plugin's side of the wire.
 */

const handle = makeTestDb();
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
const kick = vi.hoisted(() => vi.fn());
vi.mock("@/domains/jobs/kick", () => ({ kickGenerationJob: kick }));

import { createApiClient } from "@/domains/identity/machine";
import { GET as getExplainer } from "@/app/api/v1/understanding/explainers/[explainerId]/route";
import { GET as getCheck, POST as postCheck } from "@/app/api/v1/understanding/explainers/[explainerId]/check/route";
import { GET as listExplainers, POST as postExplainer } from "@/app/api/v1/understanding/explainers/route";
import { GET as getKnown } from "@/app/api/v1/understanding/known/route";
import { GET as getPreferences } from "@/app/api/v1/understanding/preferences/route";

beforeAll(() => {
  holder.db = handle.db;
});
afterAll(async () => {
  await handle.client.end();
});

async function keyFor(label: string, scopes: string[]) {
  const { userId, workspaceId } = await seedWorkspace(holder.db!, `und-api-${label}-${Date.now()}`);
  const { token } = await createApiClient(
    { userId, workspaceId, role: "owner" },
    { name: label, kind: "machine", scopes },
  );
  return token;
}

const call = (
  handler: (request: Request, ctx: never) => Promise<Response>,
  token: string,
  init: RequestInit = {},
  params = {},
  path = "",
) =>
  handler(
    new Request(`http://localhost/api/v1/understanding${path}`, {
      ...init,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    }),
    { params: Promise.resolve(params) } as never,
  );

const BODY = {
  repo: "acme/queue",
  commit: "0123456789abcdef0123456789abcdef01234567",
  range: "main..HEAD",
  summary: "Capped retries with a budget.",
  diff: "diff --git a/a.ts b/a.ts\n+++ b/a.ts\n+x",
  requestKey: "api-test",
};

describe("understanding API", { timeout: 30_000 }, () => {
  it("creates one explainer per request key and answers 202 with an id to poll", async () => {
    const token = await keyFor("create", ["understanding:read", "understanding:write"]);
    kick.mockClear();
    const first = await call(postExplainer, token, { method: "POST", body: JSON.stringify(BODY) });
    expect(first.status).toBe(202);
    const { explainer } = await first.json();
    expect(explainer).toMatchObject({
      status: "pending",
      repo: "acme/queue",
      notePath: null,
      quizPath: null,
      passed: false,
    });
    expect(kick).toHaveBeenCalledTimes(1);

    const again = await call(postExplainer, token, { method: "POST", body: JSON.stringify(BODY) });
    expect((await again.json()).explainer.id).toBe(explainer.id);
    expect(kick).toHaveBeenCalledTimes(1);

    const polled = await call(getExplainer, token, {}, { explainerId: explainer.id });
    expect((await polled.json()).explainer.status).toBe("pending");

    const listed = await call(listExplainers, token, {}, {}, `/explainers?repo=acme/queue&commit=${BODY.commit}`);
    expect((await listed.json()).explainers.map((row: { id: string }) => row.id)).toEqual([explainer.id]);
  });

  it("holds the check at 409 not_ready until the explainer is written", async () => {
    const token = await keyFor("pending", ["understanding:read", "understanding:write"]);
    const created = await call(postExplainer, token, {
      method: "POST",
      body: JSON.stringify({ ...BODY, requestKey: "pending" }),
    });
    const { explainer } = await created.json();
    const check = await call(getCheck, token, {}, { explainerId: explainer.id });
    expect(check.status).toBe(409);
    expect((await check.json()).code).toBe("not_ready");
    const answered = await call(
      postCheck,
      token,
      { method: "POST", body: JSON.stringify({ answers: [] }) },
      { explainerId: explainer.id },
    );
    expect(answered.status).toBe(409);
  });

  it("refuses a key without the scope, and a malformed body", async () => {
    const readOnly = await keyFor("readonly", ["understanding:read"]);
    const denied = await call(postExplainer, readOnly, { method: "POST", body: JSON.stringify(BODY) });
    expect(denied.status).toBe(403);

    const captureOnly = await keyFor("capture", ["captures:write"]);
    expect((await call(getKnown, captureOnly, {}, {}, "/known")).status).toBe(403);

    const writer = await keyFor("writer", ["understanding:read", "understanding:write"]);
    const bad = await call(postExplainer, writer, {
      method: "POST",
      body: JSON.stringify({ ...BODY, commit: "not-a-sha" }),
    });
    expect(bad.status).toBe(422);
    expect((await call(getExplainer, writer, {}, { explainerId: "nope" })).status).toBe(404);
    expect((await call(listExplainers, writer, {}, {}, "/explainers")).status).toBe(422);
  });

  it("reads every switch as off until the person turns it on, and an empty slate of concepts", async () => {
    const token = await keyFor("prefs", ["understanding:read"]);
    const prefs = await call(getPreferences, token, {}, {}, "/preferences");
    expect(await prefs.json()).toEqual({
      autoSuggest: false,
      pushWarning: false,
      questionCount: 5,
      difficulty: "standard",
    });
    const known = await call(getKnown, token, {}, {}, "/known?topic=retry");
    expect(await known.json()).toEqual({ topic: "retry", concepts: [] });
  });
});
