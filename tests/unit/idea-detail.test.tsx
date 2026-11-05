import { describe, expect, it, vi } from "vitest";

/*
 * The idea card has no page of its own any more — it is a modal over the
 * collection. This route exists only so the old entry points (vault duplicate
 * warnings, graph panel, chat record links) keep working: it must send every
 * id to `/polymath/ideas?idea=<id>`, preserving the id exactly, including one
 * that needs URL-encoding.
 */

const { redirect } = vi.hoisted(() => ({ redirect: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect }));

const { default: IdeaDetailRedirect } = await import("@/app/(workspace)/polymath/ideas/[id]/page");

describe("IdeaDetailRedirect", () => {
  it("sends a valid id to the collection with the modal open", async () => {
    await IdeaDetailRedirect({ params: Promise.resolve({ id: "6f1c2b7a-5b3e-4c8d-9a10-2b3c4d5e6f70" }) });
    expect(redirect).toHaveBeenCalledWith("/polymath/ideas?idea=6f1c2b7a-5b3e-4c8d-9a10-2b3c4d5e6f70");
  });

  it("URL-encodes a hostile id rather than building a broken href", async () => {
    await IdeaDetailRedirect({ params: Promise.resolve({ id: "a b?c" }) });
    expect(redirect).toHaveBeenCalledWith("/polymath/ideas?idea=a%20b%3Fc");
  });
});
