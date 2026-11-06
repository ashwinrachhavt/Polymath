import { describe, expect, it, vi } from "vitest";
import { UserError } from "@/domains/superagent/core/errors";
import { bindGuarded, fail, guarded, ok } from "@/lib/result";

/*
 * guarded is the bug-channel boundary for server actions: expected domain
 * errors become typed failures, everything else rethrows into Next's
 * 500/digest path. These tests pin both directions so a future edit cannot
 * silently start swallowing unknown errors (or leaking their messages), or
 * start 500-ing on known domain ones.
 */

class QuotaConflictError extends Error {}
class StaleRevisionError extends Error {}

describe("ok/fail", () => {
  it("spreads the payload next to ok", () => {
    expect(ok({ id: "n_1", saved: true })).toEqual({ ok: true, id: "n_1", saved: true });
  });

  it("carries only the failure message", () => {
    expect(fail("Give the note a title.")).toEqual({ ok: false, error: "Give the note a title." });
  });
});

describe("guarded", () => {
  it("spreads a successful body and runs onSuccess", async () => {
    const onSuccess = vi.fn();
    await expect(guarded(async () => ({ id: "n_1" }), { onSuccess })).resolves.toEqual({ ok: true, id: "n_1" });
    expect(onSuccess).toHaveBeenCalledTimes(1);
  });

  it("maps a UserError to a typed failure", async () => {
    const result = await guarded(async () => {
      throw new UserError("unknownRun", { run: "r_1" });
    });
    expect(result).toEqual({ ok: false, error: "Unknown assignment" });
  });

  it("maps a known domain error to its message", async () => {
    const result = await guarded(
      async () => {
        throw new QuotaConflictError("That quota is already claimed.");
      },
      { domainErrors: [QuotaConflictError] },
    );
    expect(result).toEqual({ ok: false, error: "That quota is already claimed." });
  });

  it("maps an ad-hoc error through mapError", async () => {
    const result = await guarded(
      async () => {
        throw new Error("task not found: t_1");
      },
      {
        mapError: (error) =>
          error instanceof Error && error.message.startsWith("task not found")
            ? "That task no longer exists."
            : undefined,
      },
    );
    expect(result).toEqual({ ok: false, error: "That task no longer exists." });
  });

  it("keeps the class list ahead of mapError when both match", async () => {
    const result = await guarded(
      async () => {
        throw new StaleRevisionError("task not found: t_1");
      },
      {
        domainErrors: [StaleRevisionError],
        mapError: (error) =>
          error instanceof Error && error.message.startsWith("task not found")
            ? "That task no longer exists."
            : undefined,
      },
    );
    expect(result).toEqual({ ok: false, error: "task not found: t_1" });
  });

  it("rethrows unexpected errors, preserving the 500/digest path", async () => {
    const unexpected = new Error("driver exploded");
    await expect(
      guarded(async () => {
        throw unexpected;
      }),
    ).rejects.toBe(unexpected);
  });

  it("rethrows unknown errors even when mapError passes on them", async () => {
    const unexpected = new Error("driver exploded");
    await expect(
      guarded(
        async () => {
          throw unexpected;
        },
        { mapError: () => undefined },
      ),
    ).rejects.toBe(unexpected);
  });

  it("without options, success still spreads and errors still rethrow", async () => {
    await expect(guarded(async () => ({}))).resolves.toEqual({ ok: true });
    const unexpected = new Error("boom");
    await expect(
      guarded(async () => {
        throw unexpected;
      }),
    ).rejects.toBe(unexpected);
  });
});

describe("bindGuarded", () => {
  it("binds the per-file options once", async () => {
    const onSuccess = vi.fn();
    const guardedWithRevalidate = bindGuarded({ domainErrors: [QuotaConflictError], onSuccess });
    await expect(guardedWithRevalidate(async () => ({ id: "n_1" }))).resolves.toEqual({ ok: true, id: "n_1" });
    expect(onSuccess).toHaveBeenCalledTimes(1);
    await expect(
      guardedWithRevalidate(async () => {
        throw new QuotaConflictError("Taken.");
      }),
    ).resolves.toEqual({ ok: false, error: "Taken." });
    await expect(
      guardedWithRevalidate(async () => {
        throw new StaleRevisionError("Stale.");
      }),
    ).rejects.toBeInstanceOf(StaleRevisionError);
  });
});
