import { beforeEach, describe, expect, it, vi } from "vitest";

/*
 * The inbox's "Generate zettels" boundary. A click, a malformed click, and a
 * double click all arrive here; the queue and the review count are the domain's
 * job, so these tests pin what the action itself promises: validation before
 * any write, an honest sentence when there is nothing to read, the replay
 * answer, and a failure that surfaces as a message the button can render
 * rather than a thrown stack that blanks the pane.
 */

vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), updateTag: vi.fn() }));
vi.mock("@/lib/auth", () => ({
  getAuthContext: vi.fn(async () => ({ userId: "u1", workspaceId: "w1", role: "owner" })),
}));

const domain = vi.hoisted(() => ({
  MAX_ZETTEL_SOURCE_CAPTURES: 50,
  countZettelSourceCaptures: vi.fn(),
  countPendingZettelProposals: vi.fn(),
  requestZettelGeneration: vi.fn(),
}));
vi.mock("@/domains/capture/zettel-generation", () => domain);

const { revalidatePath, updateTag } = await import("next/cache");
const { generateZettelsAction } = await import("@/app/(workspace)/command-center/inbox/zettel-actions");

const KEY = "22222222-2222-4222-8222-222222222222";
const CAPTURE = "11111111-1111-4111-8111-111111111111";

const ok = (queued: number, replayed = false) => ({
  queued,
  skipped: 0,
  captureIds: [CAPTURE],
  replayed,
});

beforeEach(() => {
  vi.clearAllMocks();
  domain.countZettelSourceCaptures.mockResolvedValue(1);
  domain.countPendingZettelProposals.mockResolvedValue(4);
});

describe("generateZettelsAction", () => {
  it("refuses a malformed request before reading or writing anything", async () => {
    for (const raw of [{}, { idempotencyKey: "not-a-uuid" }, { idempotencyKey: KEY, captureIds: ["nope"] }]) {
      const result = await generateZettelsAction(raw as never);
      expect(result).toEqual({
        ok: false,
        message: "That request was malformed. Reload the inbox and try again.",
      });
    }
    expect(domain.countZettelSourceCaptures).not.toHaveBeenCalled();
    expect(domain.requestZettelGeneration).not.toHaveBeenCalled();
    expect(updateTag).not.toHaveBeenCalled();
  });

  it("says there is nothing to read instead of queueing an empty pass", async () => {
    domain.countZettelSourceCaptures.mockResolvedValue(0);
    const result = await generateZettelsAction({ idempotencyKey: KEY });
    expect(result).toEqual({
      ok: false,
      message: "No open capture has text to read. Capture something first, or choose another filter.",
    });
    expect(domain.requestZettelGeneration).not.toHaveBeenCalled();
  });

  it("queues over the whole open inbox and reports the review depth", async () => {
    domain.requestZettelGeneration.mockResolvedValue(ok(3));
    const result = await generateZettelsAction({ idempotencyKey: KEY });
    expect(result).toEqual({ ok: true, queued: 3, skipped: 0, awaitingReview: 4, replayed: false });
    expect(domain.requestZettelGeneration).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: "w1" }),
      { idempotencyKey: KEY },
    );
    expect(revalidatePath).toHaveBeenCalledWith("/alfred/knowledge/zettels");
    expect(updateTag).toHaveBeenCalledWith("captures:w1");
  });

  it("narrows to an explicit selection", async () => {
    domain.requestZettelGeneration.mockResolvedValue(ok(1));
    await generateZettelsAction({ idempotencyKey: KEY, captureIds: [CAPTURE] });
    expect(domain.countZettelSourceCaptures).toHaveBeenCalledWith(expect.anything(), { ids: [CAPTURE] });
    expect(domain.requestZettelGeneration).toHaveBeenCalledWith(expect.anything(), {
      captureIds: [CAPTURE],
      idempotencyKey: KEY,
    });
  });

  it("returns the first click's numbers on a replay", async () => {
    domain.requestZettelGeneration.mockResolvedValue(ok(2, true));
    const result = await generateZettelsAction({ idempotencyKey: KEY });
    expect(result).toMatchObject({ ok: true, queued: 2, replayed: true });
  });

  it("surfaces a queue failure as a message and revalidates nothing", async () => {
    domain.requestZettelGeneration.mockRejectedValue(new Error("This idempotency key was used for a different request."));
    const result = await generateZettelsAction({ idempotencyKey: KEY });
    expect(result).toEqual({ ok: false, message: "This idempotency key was used for a different request." });
    expect(revalidatePath).not.toHaveBeenCalled();
  });
});
