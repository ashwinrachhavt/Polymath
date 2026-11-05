import { afterEach, describe, expect, it, vi } from "vitest";
import { GENERIC_READ_ARGS, parseCall } from "@/domains/agents/gateway";
import { LIMITS } from "@/domains/integrations/capabilities";

/*
 * parseCall is the eve gateway's per-tool-call validator: it runs on every
 * agent step, so its schemas must be built once at module load, never per
 * call. Spying on the hoisted generic-read schema pins that reuse — a
 * per-call z.object's safeParse would never be the spied instance's.
 */

describe("gateway parseCall", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("routes every generic read through one stable schema instance", () => {
    const spy = vi.spyOn(GENERIC_READ_ARGS, "safeParse");

    const valid = parseCall("googlecalendar_list_events", { query: "standup", limit: 5 });
    const validWithoutQuery = parseCall("googledrive_search_files", { limit: 2 });

    expect(spy).toHaveBeenCalledTimes(2);
    expect(valid).toMatchObject({
      ok: true,
      generic: true,
      tool: "googlecalendar_list_events",
      args: { query: "standup", limit: 5 },
    });
    expect(validWithoutQuery).toMatchObject({
      ok: true,
      generic: true,
      tool: "googledrive_search_files",
      args: { limit: 2 },
    });
  });

  it("clamps limit before validating and keeps the generic-read failure shape", () => {
    const clamped = parseCall("googlecalendar_list_events", { limit: 10_000 });
    expect(clamped).toMatchObject({ ok: true, generic: true, args: { limit: LIMITS.maxResults } });

    // The clamp is forgiving: an under-range limit becomes 1 rather than a rejection.
    const floored = parseCall("googlecalendar_list_events", { limit: 0 });
    expect(floored).toMatchObject({ ok: true, generic: true, args: { limit: 1 } });

    const invalid = parseCall("googlecalendar_list_events", { limit: "many" });
    expect(invalid).toMatchObject({ ok: false, message: expect.any(String) });
  });

  it("keeps the unknown-tool fallback shape (no generic schema consulted)", () => {
    const spy = vi.spyOn(GENERIC_READ_ARGS, "safeParse");

    const fallback = parseCall("gmail_send", {});

    expect(spy).not.toHaveBeenCalled();
    expect(fallback).toMatchObject({ ok: false, message: expect.any(String) });
  });
});
