import { beforeEach, describe, expect, it, vi } from "vitest";

// The action module reaches Clerk through getAuthContext and Postgres through
// the domain module; both are stubbed so the test exercises the action's own
// contract: validation, the error mapping, and the revalidate.
vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), updateTag: vi.fn() }));
vi.mock("@/lib/auth", () => ({
  getAuthContext: vi.fn(async () => ({ userId: "u1", workspaceId: "w1", role: "owner" })),
}));

const { ConflictError, StaleWriteError, updateCaptureText } = vi.hoisted(() => {
  class ConflictError extends Error {
    readonly code = "conflict";
  }
  class StaleWriteError extends Error {
    readonly code = "stale_write";
  }
  return { ConflictError, StaleWriteError, updateCaptureText: vi.fn() };
});
vi.mock("@/domains/capture/commands", () => ({
  ConflictError,
  StaleWriteError,
  updateCaptureText,
  // The sibling actions share the module; they are not under test here.
  createCapture: vi.fn(),
  convertCaptureToTask: vi.fn(),
  convertCaptureToNote: vi.fn(),
  setCaptureState: vi.fn(),
}));

import { updateCaptureTextAction } from "@/app/(workspace)/command-center/inbox/actions";

/*
 * The capture editor calls this boundary with whatever the person typed. An
 * empty body must be refused before it reaches the domain, a malformed id must
 * not be sent to Postgres as a uuid comparison, and a conflict must surface as
 * the message the editor renders rather than a thrown stack that blanks the
 * pane.
 */

const CAPTURE_ID = "11111111-1111-4111-8111-111111111111";
const KEY = "22222222-2222-4222-8222-222222222222";

const update = vi.mocked(updateCaptureText);

beforeEach(() => {
  update.mockReset();
});

describe("updateCaptureTextAction", () => {
  it("rejects empty and whitespace-only text without calling the domain", async () => {
    for (const text of ["", "   ", "\n\t "]) {
      expect(await updateCaptureTextAction({ captureId: CAPTURE_ID, expectedVersion: 1, text })).toEqual({
        ok: false,
        error: "A capture cannot be emptied. Archive it instead.",
      });
    }
    expect(update).not.toHaveBeenCalled();
  });

  it("rejects a malformed capture id without calling the domain", async () => {
    expect(await updateCaptureTextAction({ captureId: "not-a-uuid", expectedVersion: 1, text: "Revised" })).toMatchObject({
      ok: false,
    });
    expect(update).not.toHaveBeenCalled();
  });

  it("rejects a version below 1", async () => {
    expect(await updateCaptureTextAction({ captureId: CAPTURE_ID, expectedVersion: 0, text: "Revised" })).toMatchObject({
      ok: false,
    });
    expect(update).not.toHaveBeenCalled();
  });

  it("passes the trimmed body and the version through and returns the new version", async () => {
    update.mockResolvedValueOnce({ version: 2 } as never);
    expect(
      await updateCaptureTextAction({ captureId: CAPTURE_ID, expectedVersion: 1, text: "  Revised body  \n", idempotencyKey: KEY }),
    ).toEqual({ ok: true, version: 2 });
    expect(update.mock.calls[0][1]).toEqual({ captureId: CAPTURE_ID, expectedVersion: 1, text: "Revised body", idempotencyKey: KEY });
  });

  it("surfaces a stale write as the reload message, not a success", async () => {
    update.mockRejectedValueOnce(new StaleWriteError("The capture changed since you loaded it. Reload and try again."));
    expect(await updateCaptureTextAction({ captureId: CAPTURE_ID, expectedVersion: 1, text: "Revised" })).toEqual({
      ok: false,
      error: "The capture changed since you loaded it. Reload and try again.",
    });
  });

  it("surfaces a converted capture as a conflict message", async () => {
    update.mockRejectedValueOnce(
      new ConflictError("This capture was already converted. Editing it here would desync the record it became."),
    );
    expect(await updateCaptureTextAction({ captureId: CAPTURE_ID, expectedVersion: 1, text: "Revised" })).toEqual({
      ok: false,
      error: "This capture was already converted. Editing it here would desync the record it became.",
    });
  });
});
