import { afterEach, describe, expect, it } from "vitest";
import { editableTarget, needsLeadingSpace } from "@/components/speech/dictation-target";

/*
 * Value: protects=which focused elements dictation will write into and when a space separates the
 * words from what is already there; fails_when=dictation records for a password, number or read-only
 * field, refuses a plain text field or a rich editor, or glues words onto the previous word;
 * why_new=the helpers are new; seam=the exported helpers; no_claim=execCommand insertion and undo
 * (jsdom has no editing engine; the e2e spec covers them in Chromium)
 */

afterEach(() => {
  document.body.innerHTML = "";
});

function element(html: string): Element {
  document.body.innerHTML = html;
  return document.body.firstElementChild!;
}

describe("editableTarget", () => {
  it.each([
    "<textarea></textarea>",
    '<input type="text">',
    "<input>",
    '<input type="search">',
    '<input type="email">',
    '<input type="url">',
    '<input type="tel">',
  ])("accepts %s", (html) => {
    const field = element(html);
    expect(editableTarget(field)).toBe(field);
  });

  it.each([
    '<input type="password">',
    '<input type="number">',
    '<input type="date">',
    '<input type="checkbox">',
    '<input type="range">',
    "<textarea readonly></textarea>",
    "<textarea disabled></textarea>",
    '<input type="text" readonly>',
    "<button>Send</button>",
    "<div></div>",
  ])("refuses %s", (html) => {
    expect(editableTarget(element(html))).toBeNull();
  });

  it("refuses nothing focused", () => {
    expect(editableTarget(null)).toBeNull();
  });

  it("accepts a contenteditable editor", () => {
    const editor = element('<div contenteditable="true"></div>') as HTMLElement;
    // jsdom does not derive isContentEditable from the attribute.
    Object.defineProperty(editor, "isContentEditable", { value: true });
    expect(editableTarget(editor)).toBe(editor);
  });
});

describe("needsLeadingSpace", () => {
  it.each([
    ["", false],
    [" ", false],
    ["\n", false],
    ["\t", false],
    ["c", true],
    [".", true],
    [",", true],
  ])("before %j: %s", (charBefore, expected) => {
    expect(needsLeadingSpace(charBefore)).toBe(expected);
  });
});
