import { beforeEach, describe, expect, it, vi } from "vitest";

/*
 * The retired zettel/sitting surface must not 404. featureRoutes matches exact
 * pathnames, so the dynamic forms - a sitting session's deep link
 * (/session/<uuid>) and the "new sitting" form - are covered by this catch-all
 * page instead. It sends every one of them to Ideas.
 */

const redirect = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({ redirect }));

import ZettelsRedirect from "@/app/(workspace)/polymath/knowledge/zettels/[[...path]]/page";

// The route takes the optional segments and ignores them: every retired shape
// lands in the same place. Typed loosely here so the test can exercise the
// deep-link params the catch-all exists to accept.
const redirectPage = ZettelsRedirect as unknown as (props: { params: Promise<{ path?: string[] }> }) => Promise<void>;

beforeEach(() => {
  redirect.mockClear();
});

describe("retired zettel routes", () => {
  it.each([
    ["the collection", undefined],
    ["a session list", { path: ["session"] }],
    ["a deep sitting link", { path: ["session", "6f0f4d1e-2a3b-4c5d-8e9f-000000000000"] }],
    ["the new-sitting form", { path: ["session", "new"] }],
  ])("sends %s to Ideas", async (_label, params) => {
    await redirectPage({ params: Promise.resolve(params ?? {}) });
    expect(redirect).toHaveBeenCalledWith("/polymath/ideas");
  });
});
