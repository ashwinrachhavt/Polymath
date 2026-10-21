import { describe, expect, it, vi } from "vitest";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";

// RunDetails renders the client controls island; router access is inert here.
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => undefined }) }));

import { RunDetails } from "@/app/(workspace)/alfred/[runId]/details";

const run = {
  id: "11111111-1111-4111-8111-111111111111",
  state: "succeeded",
  model: "claude-hive-glm-5.3-flash",
  summary: "Found three leases.",
  error: null,
  createdAt: new Date("2026-10-20T08:00:00Z"),
  startedAt: new Date("2026-10-20T08:00:01Z"),
  endedAt: new Date("2026-10-20T08:02:00Z"),
};

function renderDetails(overrides: Partial<React.ComponentProps<typeof RunDetails>> = {}) {
  return renderToStaticMarkup(
    React.createElement(RunDetails, {
      run,
      policy: { allowedTools: ["tasks.read", "documents.search"], budgetUsd: { perRunCeilingUsd: "2.00" } },
      citations: [
        { documentId: "d1", title: "Lease renewal", text: "Rent rises in March.", span: { start: 0, end: 24, page: 3 } },
      ],
      events: [
        { sequence: 1, type: "message", data: { role: "user", content: "Find the leases." }, createdAt: run.createdAt },
        { sequence: 2, type: "run.succeeded", data: { summary: "Found three leases." }, createdAt: run.endedAt },
      ],
      draft: null,
      unavailable: null,
      ...overrides,
    }),
  );
}

describe("run Details disclosure", () => {
  it("is a native details element that starts closed", () => {
    const html = renderDetails();
    expect(html).toMatch(/<details class="[^"]*">/);
    expect(html).not.toContain("<details open");
    expect(html).toContain("<summary");
  });

  it("states the frozen policy, the sources read, and the timeline", () => {
    const html = renderDetails();
    expect(html).toContain("Glm 5.3 Flash");
    expect(html).toContain("tasks.read");
    expect(html).toContain("documents.search");
    expect(html).toContain("$2.00");
    expect(html).toContain("Lease renewal");
    expect(html).toContain("Found three leases.");
    expect(html).toContain("run.succeeded");
  });

  it("says spend is not read per run rather than inventing a number", () => {
    const html = renderDetails();
    expect(html).toContain("Actual spend is not read per run here yet");
  });

  it("shows no tools as none recorded, not an empty badge row", () => {
    const html = renderDetails({ policy: null });
    expect(html).toContain("none recorded");
  });
});
