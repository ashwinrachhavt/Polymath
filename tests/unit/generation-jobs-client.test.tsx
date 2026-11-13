import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GenerationJobView } from "@/domains/jobs/state";

/*
 * The browser half of background generation: the shell's stream connection
 * and Learn's "Being made" rows.
 *
 * Value: protects=a row that turns ready or failed by itself and a finished
 * job announced on whatever page the person is on; fails_when=a pushed state
 * does not reach the row, a failure shows no reason or no retry, a repeated
 * frame announces twice, the lists are not re-read when a job settles, or a
 * job nobody started sits in the queue in silence;
 * seam=the client components under jsdom with a scripted EventSource and the
 * server actions mocked; no_claim=the stream route and the job commands
 * (generation-job-state.test.ts, generation-jobs integration suite).
 */

const mocks = vi.hoisted(() => ({
  notify: vi.fn(),
  refresh: vi.fn(),
  retry: vi.fn(),
  dismiss: vi.fn(),
  startWaiting: vi.fn(async () => {}),
}));
vi.mock("@/components/workspace/workspace-provider", () => ({ useWorkspace: () => ({ notify: mocks.notify }) }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: mocks.refresh }), usePathname: () => "/learn" }));
vi.mock("@/domains/jobs/actions", () => ({
  retryGenerationJobAction: mocks.retry,
  dismissGenerationJobAction: mocks.dismiss,
  startWaitingGenerationJobAction: mocks.startWaiting,
}));

class FakeEventSource {
  static last: FakeEventSource | null = null;
  private listeners = new Map<string, (event: MessageEvent<string>) => void>();
  closed = false;
  constructor(readonly url: string) {
    FakeEventSource.last = this;
  }
  addEventListener(type: string, listener: (event: MessageEvent<string>) => void) {
    this.listeners.set(type, listener);
  }
  removeEventListener(type: string) {
    this.listeners.delete(type);
  }
  close() {
    this.closed = true;
  }
  push(job: GenerationJobView) {
    this.listeners.get("job")?.({ data: JSON.stringify(job) } as MessageEvent<string>);
  }
}

const { GenerationJobsMount } = await import("@/components/jobs/generation-jobs");
const { LearnJobs } = await import("@/app/(workspace)/learn/learn-jobs");

const running: GenerationJobView = {
  id: "job-1",
  kind: "learning.quiz",
  subject: null,
  status: "running",
  title: "Quiz: Notes",
  attempt: 1,
  href: null,
  notice: null,
  error: null,
  progress: null,
  createdAt: "2026-11-11T10:00:00.000Z",
  updatedAt: "2026-11-11T10:00:01.000Z",
};
const ready: GenerationJobView = {
  ...running,
  status: "ready",
  href: "/learn/quizzes/q1",
  notice: "Made 8 of 30 questions; the sources support no more.",
  updatedAt: "2026-11-11T10:01:00.000Z",
};
const failed: GenerationJobView = {
  ...running,
  status: "failed",
  error: "The quiz generator did not answer. Try again in a moment.",
  updatedAt: "2026-11-11T10:01:00.000Z",
};

function mount(initialJobs: GenerationJobView[]) {
  const view = render(
    <>
      <GenerationJobsMount />
      <LearnJobs initialJobs={initialJobs} kindPrefix="learning." />
    </>,
  );
  return { ...view, stream: FakeEventSource.last! };
}

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.startWaiting.mockResolvedValue(undefined);
  vi.stubGlobal("EventSource", FakeEventSource);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("background generation in the browser", () => {
  it("turns a row being made into a ready link when the stream says so, and re-reads the lists once", async () => {
    const { stream } = mount([running]);
    expect(stream.url).toBe("/api/v1/generation-jobs/stream");
    expect(screen.getByText("Being made. You can leave this page.")).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Open" })).toBeNull();

    act(() => stream.push(ready));
    act(() => stream.push(ready));

    expect(screen.getByRole("link", { name: "Open" }).getAttribute("href")).toBe("/learn/quizzes/q1");
    expect(mocks.notify).toHaveBeenCalledTimes(1);
    expect(mocks.notify).toHaveBeenCalledWith(
      "Quiz: Notes is ready. Made 8 of 30 questions; the sources support no more.",
    );
    await waitFor(() => expect(mocks.refresh).toHaveBeenCalledTimes(1));
  });

  it("shows a failure's reason on the row and retries it as a new attempt", async () => {
    const { stream } = mount([running]);
    act(() => stream.push(failed));

    expect(screen.getByRole("alert").textContent).toContain("The quiz generator did not answer.");
    expect(mocks.notify).toHaveBeenCalledWith(
      "Quiz: Notes could not be made. The quiz generator did not answer. Try again in a moment.",
    );

    const retried = { ...running, status: "queued" as const, attempt: 2, updatedAt: "2026-11-11T10:02:00.000Z" };
    mocks.retry.mockResolvedValueOnce({ ok: true, job: retried });
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));

    await screen.findByText("Waiting to start. You can leave this page.");
    expect(mocks.retry).toHaveBeenCalledWith("job-1");
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
  });

  it("shows a job that failed while the person was away, from the page's own read, and dismisses it", async () => {
    mount([failed]);
    expect(screen.getByRole("alert").textContent).toContain("The quiz generator did not answer.");

    mocks.dismiss.mockResolvedValueOnce({ ok: true });
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));

    await waitFor(() => expect(screen.queryByText("Quiz: Notes")).toBeNull());
    expect(mocks.dismiss).toHaveBeenCalledWith("job-1");
  });

  it("starts a job itself, once, and says it is slow when it has waited in the queue too long", async () => {
    const queuedLongAgo: GenerationJobView = {
      ...running,
      status: "queued",
      updatedAt: new Date(Date.now() - 60_000).toISOString(),
    };
    const { stream } = mount([]);
    act(() => stream.push(queuedLongAgo));

    await screen.findByText("Taking longer than usual to start. Still trying.");
    expect(mocks.startWaiting).toHaveBeenCalledTimes(1);
    expect(mocks.startWaiting).toHaveBeenCalledWith("job-1");

    act(() => stream.push({ ...queuedLongAgo }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(mocks.startWaiting).toHaveBeenCalledTimes(1);
  });

  it("leaves a freshly queued job alone", async () => {
    const { stream } = mount([]);
    act(() => stream.push({ ...running, status: "queued", updatedAt: new Date().toISOString() }));
    await screen.findByText("Waiting to start. You can leave this page.");
    expect(mocks.startWaiting).not.toHaveBeenCalled();
  });

  it("closes the connection when the shell unmounts", () => {
    const { unmount, stream } = mount([]);
    unmount();
    expect(stream.closed).toBe(true);
  });
});
