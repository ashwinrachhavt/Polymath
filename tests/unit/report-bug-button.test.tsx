import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createElement as h } from "react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { Toaster } from "@/components/ui/toast";
import { rememberLastError } from "@/lib/last-error";

/*
 * Value: protects=the header's Report a bug; fails_when=the report sends anything beyond the
 * route, the last error id and the chosen kind (page content would reach a public GitHub issue),
 * or a sent report gives no confirmation; seam=ReportBugButton under jsdom with the server action
 * as a spy; no_claim=the action's auth and the store (tests/integration/bug-triage)
 */

const reportBugAction = vi.fn().mockResolvedValue({ ok: true });
vi.mock("@/components/shell/report-bug-actions", () => ({
  reportBugAction: (input: unknown) => reportBugAction(input),
}));
vi.mock("next/navigation", () => ({ usePathname: () => "/notes/9f1c2a3b-1111-4222-8333-444455556666" }));

const { ReportBugButton } = await import("@/components/shell/report-bug-button");

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});

describe("ReportBugButton", () => {
  it("sends only the route, the last error id and the kind", async () => {
    rememberLastError("2840150283");
    render(h("div", null, h(ReportBugButton), h(Toaster)));
    fireEvent.click(screen.getByRole("button", { name: "Report a bug" }));
    fireEvent.click(await screen.findByRole("button", { name: "Something broke" }));

    await waitFor(() => expect(reportBugAction).toHaveBeenCalledTimes(1));
    expect(reportBugAction).toHaveBeenCalledWith({
      route: "/notes/9f1c2a3b-1111-4222-8333-444455556666",
      errorId: "2840150283",
      kind: "broken",
    });
    expect(await screen.findByText("Thanks. The report was sent.")).toBeTruthy();
  });
});
