/*
 * "Turn it into anything" (Product Spec, the Omnibox inbox): a capture
 * becomes a starter draft in a writing template the owner picks - an email
 * draft, a product spec, a tech spec, an issue. These are deterministic
 * scaffolds, not generated prose: the template carries the section skeleton and
 * the capture rides along verbatim as quoted source material, so nothing the
 * draft says was invented by the system. The owner fills the bracketed slots.
 *
 * Lives in knowledge, not capture: a task's note and a bare note use the same
 * scaffolds, so capture is no longer the owner of this registry.
 */

export const DRAFT_TEMPLATES = ["email", "product-spec", "tech-spec", "issue", "todo"] as const;
export type DraftTemplate = (typeof DRAFT_TEMPLATES)[number];

export const DRAFT_TEMPLATE_LABEL: Record<DraftTemplate, string> = {
  email: "Email draft",
  "product-spec": "Product spec",
  "tech-spec": "Tech spec",
  issue: "Issue",
  todo: "Todo",
};

/*
 * Drafts land as note-kind artifacts: the notebook editor renders notes and
 * zettels today, while memo/document artifacts have no editing surface - a
 * draft you cannot open is not "turned into" anything. The template name in
 * the title says what the draft is for.
 */
export const DRAFT_TEMPLATE_KIND: Record<DraftTemplate, "note"> = {
  email: "note",
  "product-spec": "note",
  "tech-spec": "note",
  issue: "note",
  todo: "note",
};

/**
 * The templates a capture can turn into. A capture conversion quotes the
 * capture verbatim as source material; `todo` has no source section by
 * design, so offering it here would silently drop the text the person just
 * captured. Tasks consume `todo` directly and are not created from a capture.
 */
export const CAPTURE_TEMPLATES = DRAFT_TEMPLATES.filter((template) => template !== "todo");

const MAX_TITLE = 120;

function truncate(text: string): string {
  return text.length > MAX_TITLE ? `${text.slice(0, MAX_TITLE - 1)}…` : text;
}

/** Quote the capture verbatim, one blockquote line per source line. */
function quote(text: string): string {
  return text
    .split("\n")
    .map((line) => `> ${line}`.trimEnd())
    .join("\n");
}

function sourceSection(material: string): string {
  return `## Source material\n\nCaptured verbatim - the draft above must stay true to it.\n\n${quote(material)}`;
}

const SCAFFOLD_NOTE = "\n\n---\n\n*Starter draft from a capture. Bracketed slots are yours to fill; nothing here was written for you.*";

export function draftTitle(template: DraftTemplate, firstLine: string): string {
  return truncate(`${DRAFT_TEMPLATE_LABEL[template]}: ${firstLine}`);
}

export function draftBody(template: DraftTemplate, input: { firstLine: string; material: string }): string {
  const { firstLine, material } = input;
  switch (template) {
    case "email":
      return [
        `**To:** [recipient]`,
        ``,
        `**Subject:** ${firstLine}`,
        ``,
        `---`,
        ``,
        `[Your message here - what you need, by when, and why it matters to the reader.]`,
        ``,
        sourceSection(material),
      ].join("\n") + SCAFFOLD_NOTE;
    case "product-spec":
      return [
        `# ${firstLine}`,
        ``,
        `## Problem`,
        ``,
        `[Who hurts, and how do we know?]`,
        ``,
        `## Proposal`,
        ``,
        `[What we would build, at the smallest honest scope.]`,
        ``,
        sourceSection(material),
        ``,
        `## Open questions`,
        ``,
        `- [ ] [What must be true before this is worth building?]`,
      ].join("\n") + SCAFFOLD_NOTE;
    case "tech-spec":
      return [
        `# ${firstLine}`,
        ``,
        `## Context`,
        ``,
        `[The system as it stands, and the constraint that forces this change.]`,
        ``,
        `## Design`,
        ``,
        `[The change: data flow, failure modes, migration path.]`,
        ``,
        sourceSection(material),
        ``,
        `## Risks`,
        ``,
        `- [ ] [What breaks if this is wrong?]`,
      ].join("\n") + SCAFFOLD_NOTE;
    case "issue":
      // ASH-285: a capture becomes a well-scoped issue draft. The acceptance
      // criteria start as checkboxes the owner edits, and the source stays
      // quoted below so every criterion traces back to what was captured.
      return [
        `# ${firstLine}`,
        ``,
        `## Problem`,
        ``,
        `[What is broken or missing, and for whom? One paragraph, from the source material.]`,
        ``,
        `## Proposal`,
        ``,
        `[The smallest change that resolves it.]`,
        ``,
        `## Acceptance criteria`,
        ``,
        `- [ ] [The observable behavior that proves this is done]`,
        `- [ ] [The error or empty case that must be honest]`,
        `- [ ] [The regression that must stay impossible]`,
        ``,
        `## Out of scope`,
        ``,
        `[What this issue deliberately does not do.]`,
        ``,
        sourceSection(material),
      ].join("\n") + SCAFFOLD_NOTE;
    case "todo":
      // A todo has no captured source to stay faithful to, so it carries no
      // source section and no "starter draft from a capture" footer: the first
      // line is the task, and the notes hold the owner's definition of done.
      return [
        `## Task`,
        ``,
        firstLine,
        ``,
        `## Notes`,
        ``,
        `[What done looks like.]`,
      ].join("\n");
  }
}
