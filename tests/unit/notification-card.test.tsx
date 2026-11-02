import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import {
  NotificationCard,
  type NotificationCardProps,
  type RunState,
} from "@/components/shell/notifications/NotificationCard";

/*
 * The card is the atom of the triage sheet, so the tests hold it to its
 * anatomy: the right action bar per kind, the clamped text slots, the
 * expired-decision lock, and the callbacks the panel will wire in PR3. The
 * clock is pinned by tests/unit/setup.clock.ts, which is why relative times
 * are exact strings.
 */

const NOW = new Date("2026-01-15T12:00:00Z");
const AN_HOUR_AGO = new Date("2026-01-15T11:00:00Z");

type QuestionCardProps = Extract<NotificationCardProps, { kind: "question" }>;
type DecisionCardProps = Extract<NotificationCardProps, { kind: "decision" }>;
type RunCardProps = Extract<NotificationCardProps, { kind: "run" }>;

function questionProps(overrides: Partial<QuestionCardProps> = {}): QuestionCardProps {
  const base: QuestionCardProps = {
    id: "q1",
    kind: "question",
    questionText: "Who is this person?",
    askedAt: NOW,
    onReply: vi.fn(),
    onDismiss: vi.fn(),
    onOpen: vi.fn(),
  };
  return { ...base, ...overrides };
}

function decisionProps(overrides: Partial<DecisionCardProps> = {}): DecisionCardProps {
  const base: DecisionCardProps = {
    id: "d1",
    kind: "decision",
    decisionType: "action",
    title: "Send the quarterly summary",
    detail: "Writes to the shared workspace note",
    expired: false,
    askedAt: AN_HOUR_AGO,
    onDecide: vi.fn(),
    onOpen: vi.fn(),
  };
  return { ...base, ...overrides };
}

function runProps(overrides: Partial<RunCardProps> = {}): RunCardProps {
  const base: RunCardProps = {
    id: "r1",
    kind: "run",
    runState: "running",
    title: "Onboarding interview",
    summary: null,
    askedAt: NOW,
    onOpen: vi.fn(),
  };
  return { ...base, ...overrides };
}

describe("NotificationCard anatomy", () => {
  it("renders the ribbon pills, the question text, and the reply bar for a question", () => {
    render(<NotificationCard {...questionProps()} />);

    expect(screen.getByText("Agent")).toBeDefined();
    expect(screen.getByText("Needs you")).toBeDefined();
    expect(screen.getByText("Now")).toBeDefined();
    expect(screen.getByText("Who is this person?")).toBeDefined();
    expect(screen.getByRole("textbox", { name: "Reply to the agent" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Reply" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Dismiss" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Open run" })).toBeDefined();
  });

  it("marks the option with the command-result styling and the selection state", () => {
    const selected = render(<NotificationCard {...runProps({ selected: true })} />);
    const option = screen.getByRole("option");

    expect(option.getAttribute("aria-selected")).toBe("true");
    expect(option.className).toContain("command-result");
    expect(option.id).toBe("r1");
    selected.unmount();

    render(<NotificationCard {...runProps()} />);
    expect(screen.getByRole("option").getAttribute("aria-selected")).toBe("false");
  });

  it("clamps the title to one line and the detail to two", () => {
    const { container } = render(<NotificationCard {...decisionProps()} />);

    expect(container.querySelector("h4")?.className).toContain("line-clamp-1");
    expect(container.querySelector("p")?.className).toContain("line-clamp-2");
  });

  it("renders the relative time with timeAgoShort", () => {
    render(<NotificationCard {...decisionProps()} />);

    expect(screen.getByText("1h")).toBeDefined();
  });
});

describe("NotificationCard reply path", () => {
  it("submits the trimmed draft, clears the input, and calls onReply", () => {
    const onReply = vi.fn();
    render(<NotificationCard {...questionProps({ onReply })} />);

    fireEvent.change(screen.getByRole("textbox", { name: "Reply to the agent" }), {
      target: { value: "  She is Pino Corgi  " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Reply" }));

    expect(onReply).toHaveBeenCalledWith("She is Pino Corgi");
    expect(onReply).toHaveBeenCalledTimes(1);
    expect(screen.getByDisplayValue("")).toBeDefined();
  });

  // jsdom does not turn an Enter keydown in a text input into a form
  // submission, so the test drives the submit event that Enter produces in a
  // browser; the form wrapper is what makes Enter submit.
  it("submits the reply when the form is submitted by the Enter path", () => {
    const onReply = vi.fn();
    render(<NotificationCard {...questionProps({ onReply })} />);

    fireEvent.change(screen.getByRole("textbox", { name: "Reply to the agent" }), {
      target: { value: "Reschedule to Tuesday" },
    });
    const form = screen.getByRole("textbox", { name: "Reply to the agent" }).closest("form");
    expect(form).not.toBeNull();
    fireEvent.submit(form!);

    expect(onReply).toHaveBeenCalledWith("Reschedule to Tuesday");
    expect(screen.getByDisplayValue("")).toBeDefined();
  });

  it("keeps Reply disabled while the draft is blank, so an empty answer never submits", () => {
    render(<NotificationCard {...questionProps()} />);
    const reply = screen.getByRole("button", { name: "Reply" });

    expect(reply.hasAttribute("disabled")).toBe(true);

    fireEvent.change(screen.getByRole("textbox", { name: "Reply to the agent" }), { target: { value: "   " } });

    expect(reply.hasAttribute("disabled")).toBe(true);
  });

  it("calls onDismiss and onOpen from the question's secondary actions", () => {
    const onDismiss = vi.fn();
    const onOpen = vi.fn();
    render(<NotificationCard {...questionProps({ onDismiss, onOpen })} />);

    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    fireEvent.click(screen.getByRole("button", { name: "Open run" }));

    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(onOpen).toHaveBeenCalledTimes(1);
  });
});

describe("NotificationCard decision path", () => {
  it("wires Approve and Reject to onDecide as intents and keeps Open context live", () => {
    const onDecide = vi.fn();
    const onOpen = vi.fn();
    render(<NotificationCard {...decisionProps({ onDecide, onOpen })} />);

    expect(screen.getByText("Agent")).toBeDefined();
    expect(screen.getByText("Waiting on you")).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    fireEvent.click(screen.getByRole("button", { name: "Reject" }));

    expect(onDecide).toHaveBeenNthCalledWith(1, "approve");
    expect(onDecide).toHaveBeenNthCalledWith(2, "reject");

    fireEvent.click(screen.getByRole("button", { name: "Open context" }));
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it("labels a capture decision as Capture", () => {
    render(<NotificationCard {...decisionProps({ decisionType: "capture" })} />);

    expect(screen.getByText("Capture")).toBeDefined();
  });

  it("disables Approve and Reject on an expired decision but keeps context open", () => {
    render(<NotificationCard {...decisionProps({ expired: true })} />);
    const approve = screen.getByRole("button", { name: "Approve" });
    const reject = screen.getByRole("button", { name: "Reject" });
    const open = screen.getByRole("button", { name: "Open context" });

    expect(approve.hasAttribute("disabled")).toBe(true);
    expect(reject.hasAttribute("disabled")).toBe(true);
    expect(open.hasAttribute("disabled")).toBe(false);
    expect(screen.getByText("Expired")).toBeDefined();
  });
});

describe("NotificationCard run path", () => {
  const IN_FLIGHT: [RunState, string][] = [
    ["queued", "Queued"],
    ["running", "Running"],
    ["waiting_input", "Waiting on you"],
    ["waiting_approval", "Waiting on your approval"],
  ];
  const TERMINAL: [RunState, string][] = [
    ["succeeded", "Finished"],
    ["failed", "Failed"],
    ["cancelled", "Cancelled"],
  ];

  it.each(IN_FLIGHT)("shows the pulse dot and Open only for an in-flight %s run", (runState, label) => {
    const { container } = render(<NotificationCard {...runProps({ runState })} />);

    expect(screen.getByText("Run")).toBeDefined();
    expect(screen.getByText(label)).toBeDefined();
    expect(container.querySelector(".animate-pulse")).not.toBeNull();
    expect(screen.getByRole("button", { name: "Open" })).toBeDefined();
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it.each(TERMINAL)("shows Open only and no pulse dot for a %s run", (runState, label) => {
    const { container } = render(<NotificationCard {...runProps({ runState })} />);

    expect(screen.getByText(label)).toBeDefined();
    expect(container.querySelector(".animate-pulse")).toBeNull();
    expect(screen.getByRole("button", { name: "Open" })).toBeDefined();
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("marks a failed run with the danger pill", () => {
    const { container } = render(<NotificationCard {...runProps({ runState: "failed" })} />);

    expect(container.querySelector(".pill-danger")?.textContent).toBe("Failed");
  });

  it("prefers the agent summary over the objective label in the heading", () => {
    render(<NotificationCard {...runProps({ summary: "Read 3 pages and indexed 12 notes" })} />);

    expect(screen.getByText("Read 3 pages and indexed 12 notes")).toBeDefined();
    expect(screen.queryByText("Onboarding interview")).toBeNull();
  });

  it("falls back to the objective label when no summary exists", () => {
    render(<NotificationCard {...runProps({ summary: null })} />);

    expect(screen.getByText("Onboarding interview")).toBeDefined();
  });
});
