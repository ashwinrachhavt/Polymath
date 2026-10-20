import { describe, expect, it, vi } from "vitest";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), updateTag: vi.fn() }));
vi.mock("@/lib/auth", () => ({
  getAuthContext: vi.fn(async () => ({ userId: "u1", workspaceId: "w1", role: "owner" })),
}));
vi.mock("@/domains/identity/party-csv", async () => {
  // The error class must be the real one: the action matches on instanceof.
  const actual = await vi.importActual<typeof import("@/domains/identity/party-csv")>(
    "@/domains/identity/party-csv",
  );
  return { ImportBusyError: actual.ImportBusyError, ImportLimitError: actual.ImportLimitError, importConnections: vi.fn() };
});

import { importConnections } from "@/domains/identity/party-csv";
import { importConnectionsCsv } from "@/app/(workspace)/command-center/relationships/actions";

/*
 * The import action's error contract: the one refusal the owner can act on
 * (file too large) comes back as a message; anything else is rethrown so the
 * error boundary shows it rather than the screen claiming an empty import.
 */

const run = vi.mocked(importConnections);

describe("importConnectionsCsv", () => {
  it("rejects an empty body without calling the domain", async () => {
    expect(await importConnectionsCsv({ csv: "" })).toEqual({
      ok: false,
      error: "That file could not be read as text.",
    });
    expect(run).not.toHaveBeenCalled();
  });

  it("returns the summary on success", async () => {
    const summary = {
      rowsRead: 1,
      peopleCreated: 1,
      peopleMatched: 0,
      organizationsCreated: 0,
      skipped: 0,
      problems: [],
    };
    run.mockResolvedValueOnce(summary);
    expect(await importConnectionsCsv({ csv: "a,b\n" })).toEqual({ ok: true, summary });
  });

  it("turns the row limit into a message the owner can act on", async () => {
    const { ImportLimitError } = await import("@/domains/identity/party-csv");
    run.mockRejectedValueOnce(new ImportLimitError(9000));
    const result = await importConnectionsCsv({ csv: "a,b\n" });
    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ error: expect.stringContaining("9000 rows") });
  });

  it("rethrows anything else to the error boundary", async () => {
    run.mockRejectedValueOnce(new Error("connection reset"));
    await expect(importConnectionsCsv({ csv: "a,b\n" })).rejects.toThrow("connection reset");
  });
});
