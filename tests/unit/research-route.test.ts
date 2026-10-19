import { beforeEach, describe, expect, it, vi } from "vitest";
import { CompanyResearchError } from "@/domains/knowledge/company-research";
import type { AuthContext } from "@/lib/auth";

/*
 * The research route's own contract (ASH-114): parse, idempotency-key shape,
 * role gate, status codes, error mapping. The engine behind it is covered by
 * the company-research unit and integration suites; here it is stubbed so the
 * route is tested without adapter plumbing.
 */

const holder: { auth: AuthContext | undefined } = { auth: undefined };
const runResearch = vi.fn();

vi.mock("@/lib/auth", () => ({
  authedHandler: (handler: (auth: NonNullable<typeof holder.auth>, request: Request, ctx: unknown) => Promise<Response>) =>
    (request: Request, ctx: unknown) => handler(holder.auth!, request, ctx),
}));
vi.mock("@/domains/knowledge/company-research", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/domains/knowledge/company-research")>();
  return { ...actual, runCompanyResearch: (...args: unknown[]) => runResearch(...args) };
});

import { POST } from "@/app/api/v1/research/company/route";

const owner: AuthContext = { userId: "u-1", workspaceId: "w-1", role: "owner" };
const post = (body: unknown, key?: string) =>
  POST(new Request("https://axiom.test/api/v1/research/company", {
    method: "POST",
    headers: { "content-type": "application/json", ...(key ? { "idempotency-key": key } : {}) },
    body: JSON.stringify(body),
  }), undefined as never);

beforeEach(() => {
  holder.auth = owner;
  runResearch.mockReset();
  runResearch.mockResolvedValue({ artifactId: "a-1", versionId: "v-1", title: "Acme case study", manifestSize: 3, groundedSections: 8, gapSections: 1, replayed: false });
});

describe("POST /api/v1/research/company", () => {
  it("201 with the engine result and the idempotency key passed through", async () => {
    const key = crypto.randomUUID();
    const res = await post({ companyName: "Acme", depth: "quick" }, key);
    expect(res.status).toBe(201);
    expect(runResearch).toHaveBeenCalledOnce();
    const input = runResearch.mock.calls[0][1] as { idempotencyKey?: string; mode: string };
    expect(input.idempotencyKey).toBe(key);
    expect(input.mode).toBe("public");
  });

  it("200 on a replayed pass", async () => {
    runResearch.mockResolvedValue({ artifactId: "a-1", replayed: true });
    const res = await post({ companyName: "Acme" });
    expect(res.status).toBe(200);
  });

  it("422 on a missing company name or a malformed date", async () => {
    expect((await post({})).status).toBe(422);
    expect((await post({ companyName: "Acme", asOfDate: "2026-1-1" })).status).toBe(422);
    expect(runResearch).not.toHaveBeenCalled();
  });

  it("400 on a non-UUID Idempotency-Key", async () => {
    expect((await post({ companyName: "Acme" }, "not-a-uuid")).status).toBe(400);
    expect(runResearch).not.toHaveBeenCalled();
  });

  it("maps an engine input error to 422", async () => {
    runResearch.mockRejectedValue(new CompanyResearchError("Dossier-only research needs a dossierId."));
    const res = await post({ companyName: "Acme", mode: "dossier-only" });
    expect(res.status).toBe(422);
  });

  it("a viewer cannot buy a research pass", async () => {
    holder.auth = { ...owner, role: "viewer" };
    await expect(post({ companyName: "Acme" })).rejects.toThrow(/Requires member/);
    expect(runResearch).not.toHaveBeenCalled();
  });
});
