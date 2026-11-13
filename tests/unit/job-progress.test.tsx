import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GenerationJobView } from "@/domains/jobs/state";

/*
 * Value: protects=the inline progress under a row: "Queued" before a job
 * starts, one bar and the live step while it runs, a check with what it made
 * when it finishes in view, and nothing for work that was already done when
 * the row rendered; fails_when=a queued job shows plumbing text or a bar, the
 * step or its counts are not shown, a job that finished before the row mounted
 * flashes a check, the check never clears, or a failure hides its reason;
 * seam=the component under jsdom with the jobs store left empty;
 * no_claim=the stream that feeds the store (generation-jobs-client.test.tsx).
 */

const { JobProgress } = await import("@/components/jobs/job-progress");

const base: GenerationJobView = {
  id: "job-1",
  kind: "knowledge.crawl",
  subject: "capture:c1",
  status: "queued",
  title: "Reading docs.example",
  attempt: 1,
  href: null,
  notice: null,
  error: null,
  progress: null,
  createdAt: "2026-11-12T10:00:00.000Z",
  updatedAt: "2026-11-12T10:00:00.000Z",
};

afterEach(() => vi.useRealTimers());

describe("JobProgress", () => {
  it("renders nothing without a job", () => {
    const { container } = render(<JobProgress job={null} />);
    expect(container.innerHTML).toBe("");
  });

  it("says Queued before the job starts, with no bar", () => {
    render(<JobProgress job={base} />);
    expect(screen.getByText("Queued")).toBeTruthy();
    expect(screen.queryByRole("progressbar")).toBeNull();
  });

  it("shows the live step and a bar sized to its counts while the job runs", () => {
    render(<JobProgress job={{ ...base, status: "running", progress: { step: "Crawling", done: 5, total: 20 } }} />);
    expect(screen.getByText("Crawling 5/20…")).toBeTruthy();
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("25");
  });

  it("shows an indeterminate bar when the step has no total", () => {
    render(
      <JobProgress
        job={{ ...base, status: "running", progress: { step: "Fetching captions", done: null, total: null } }}
      />,
    );
    expect(screen.getByText("Fetching captions…")).toBeTruthy();
    expect(screen.getByRole("progressbar").hasAttribute("aria-valuenow")).toBe(false);
  });

  it("closes into a check with what it made when the job finishes in view, then clears", () => {
    vi.useFakeTimers();
    const { rerender, container } = render(<JobProgress job={{ ...base, status: "running" }} />);
    rerender(<JobProgress job={{ ...base, status: "ready", notice: "Read 19 pages from docs.example." }} />);
    expect(screen.getByText("Read 19 pages from docs.example.")).toBeTruthy();
    expect(container.querySelector('[data-job-mark="ready"]')).not.toBeNull();
    act(() => void vi.advanceTimersByTime(2_500));
    expect(container.innerHTML).toBe("");
  });

  it("shows nothing for a job that was already done when the row rendered", () => {
    const { container } = render(<JobProgress job={{ ...base, status: "ready", notice: "Done." }} />);
    expect(container.innerHTML).toBe("");
  });

  it("keeps a failure on screen with its reason", () => {
    render(<JobProgress job={{ ...base, status: "failed", error: "The site reader could not be reached." }} />);
    expect(screen.getByRole("alert").textContent).toContain("The site reader could not be reached.");
  });
});
