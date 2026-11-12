import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/*
 * Value: protects=Find similar notes asks meaning search with the live text,
 * lists the answers, and writes a [[link]] only when the writer clicks Link;
 * fails_when=it searches a stale note, links without a click, offers to link
 * a note the text already links, or presents an unavailable meaning search as
 * "nothing similar"; why_new=the feature is new; seam=the similar-notes action
 * and the onLink/onOpen callbacks; no_claim=ranking quality, which belongs to
 * searchKnowledge
 */

vi.mock("@/app/(workspace)/polymath/notes/actions", () => ({ similarNotesAction: vi.fn() }));

import { similarNotesAction } from "@/app/(workspace)/polymath/notes/actions";
import { SimilarNotesButton } from "@/app/(workspace)/polymath/notes/similar-notes";

const ask = vi.mocked(similarNotesAction);
const hit = (id: string, title: string, similarity = 0.61) => ({
  id,
  title,
  kind: "note",
  similarity,
  snippet: `${title} opening`,
});

function renderButton(markdown: string, handlers = { onLink: vi.fn(), onOpen: vi.fn() }) {
  render(<SimilarNotesButton noteId="n1" title="Retrieval" markdown={markdown} {...handlers} />);
  fireEvent.click(screen.getByRole("button", { name: "Find similar notes" }));
  return handlers;
}

beforeEach(() => ask.mockReset());

describe("Find similar notes", () => {
  it("asks with the text on screen and links a candidate only on a click", async () => {
    ask.mockResolvedValue({ meaning: "ok", notes: [hit("a", "Vector [index] trade-offs"), hit("b", "Hybrid search")] });
    const { onLink } = renderButton("Reranking only reorders what retrieval found.");
    expect(ask).toHaveBeenCalledWith({
      noteId: "n1",
      title: "Retrieval",
      text: "Reranking only reorders what retrieval found.",
    });
    const link = await screen.findByRole("button", { name: "Link Vector [index] trade-offs" });
    expect(screen.getAllByText("61%")).toHaveLength(2);
    expect(onLink).not.toHaveBeenCalled();

    fireEvent.click(link);
    // Brackets in a title would break the [[ ]] it is written into.
    expect(onLink).toHaveBeenCalledWith("[[Vector index trade-offs]] ");
  });

  it("marks a note the text already links instead of offering it again", async () => {
    ask.mockResolvedValue({ meaning: "ok", notes: [hit("b", "Hybrid search")] });
    renderButton("See [[hybrid search|the hybrid note]].");
    const linked = await screen.findByRole("button", { name: "Hybrid search is linked" });
    expect((linked as HTMLButtonElement).disabled).toBe(true);
  });

  it("opens a candidate beside the note from its title", async () => {
    ask.mockResolvedValue({ meaning: "ok", notes: [hit("b", "Hybrid search")] });
    const { onOpen } = renderButton("text");
    fireEvent.click(await screen.findByText("Hybrid search"));
    expect(onOpen).toHaveBeenCalledWith("b");
  });

  it("says meaning search is not set up rather than claiming nothing is similar", async () => {
    ask.mockResolvedValue({ meaning: "unconfigured", notes: [] });
    renderButton("text");
    expect(await screen.findByText(/Meaning search is not set up/)).toBeTruthy();
    expect(screen.queryByText(/Nothing close/)).toBeNull();
  });

  it("offers a retry when the search fails", async () => {
    ask
      .mockRejectedValueOnce(new Error("network"))
      .mockResolvedValueOnce({ meaning: "ok", notes: [hit("b", "Hybrid search")] });
    renderButton("text");
    fireEvent.click(await screen.findByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Hybrid search")).toBeTruthy();
    expect(ask).toHaveBeenCalledTimes(2);
  });
});
