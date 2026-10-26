import { describe, expect, it } from "vitest";
import {
  REFUSAL_MESSAGE_MAX,
  refusalMessage,
} from "@/domains/actions/refusal-message";

/*
 * The refusal note is persisted long-term and rendered on the review card,
 * so it must be a bounded, printable, single line - never a raw provider
 * body. The executor's own refusal strings pass through verbatim.
 */
describe("refusalMessage", () => {
  it("passes the executor's own disabled-deployment refusal through unchanged", () => {
    const error = new Error(
      "Canva import is not enabled on this deployment; the import cannot be dispatched.",
    );
    expect(refusalMessage(error)).toBe(
      "Canva import is not enabled on this deployment; the import cannot be dispatched.",
    );
  });

  it("keeps only the first line of a multi-line provider body", () => {
    const error = new Error(
      'Composio 400: {"error":"bad request"}\n{"stack":"secret internals","trace":"..."}',
    );
    expect(refusalMessage(error)).toBe('Composio 400: {"error":"bad request"}');
  });

  it("strips control characters instead of persisting them", () => {
    const error = new Error("provider exploded\u0001\u0002\twith bells\u0007");
    const message = refusalMessage(error);
    expect(message).toBe("provider exploded with bells");
    expect(message).not.toMatch(/[\u0000-\u001f\u007f]/);
  });

  it("bounds a raw provider body to a user-facing length", () => {
    const error = new Error(`refused: ${"x".repeat(5000)}`);
    const message = refusalMessage(error);
    expect(message).toHaveLength(REFUSAL_MESSAGE_MAX);
    expect(message.startsWith("refused: ")).toBe(true);
  });

  it("falls back to a generic message for non-Error failures and blank messages", () => {
    expect(refusalMessage("string failure")).toBe(
      "The approved effect did not run.",
    );
    expect(refusalMessage(new Error("  \n  "))).toBe(
      "The approved effect did not run.",
    );
  });
});
