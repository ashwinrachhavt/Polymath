import { parseCase, type Assertion } from "./types";
const search: Assertion = { kind: "equals", target: "toolCall", tool: "documents_search", severity: "gate", label: "consults documents", expected: true };
export { cases as default };
const cases = [
  parseCase({ id: "chat-grounding/groundedAnswer", suite: "chat-grounding", fixtureOnly: false,
    objective: "How much is my rent and when is it due?", assertions: [search,
      { kind: "includes", target: "reply", severity: "gate", label: "lease cited", expected: "lease" },
      { kind: "includes", target: "reply", severity: "gate", label: "rent grounded", expected: "2,400" },
    ] }),
  parseCase({ id: "chat-grounding/noMatch", suite: "chat-grounding", fixtureOnly: false,
    objective: "What does my car insurance policy cover?", assertions: [search,
      { kind: "includes", target: "reply", severity: "gate", label: "states absence", expected: /no |not |unable|couldn'?t|cannot|nothing|didn'?t find|no match/i },
    ] }),
];
