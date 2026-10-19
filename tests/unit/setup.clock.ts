import { vi } from "vitest";

/*
 * Unit tests start every file under one pinned clock: a date that was true
 * when a test was written stays true on every later run. (The recurrence
 * suite broke main the night wall-clock time passed its hardcoded dates.)
 * Noon UTC keeps local-date math off every midnight and DST boundary. Only
 * Date is faked, so timers, awaits and performance.now behave as usual; a
 * test that needs its own moment can re-pin and restore as before.
 */
vi.useFakeTimers({ toFake: ["Date"] });
vi.setSystemTime(new Date("2026-01-15T12:00:00Z"));
