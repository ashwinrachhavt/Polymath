import type { Observation } from "../../evals-langgraph/src/cases/types";
// Authored regression transcripts, not evidence of live model/app execution.
export const transcripts: Record<string, Observation> = {
  "chat-grounding/groundedAnswer": { reply: "Your lease says monthly rent is 2,400, due on the first.", toolCalls: [{ name: "documents_search", input: { query: "rent" } }], fixture: {} },
  "chat-grounding/noMatch": { reply: "I was unable to find any matching car insurance policy.", toolCalls: [{ name: "documents_search", input: { query: "car insurance" } }], fixture: {} },
  "desirable-outputs/linearDraftFromPastedMaterial": {
    reply: "A draft is ready for review; nothing has been filed yet.",
    toolCalls: [{ name: "linear_issue_propose", input: { text: "The inbox badge shows 3 unread after I archived everything — the count is not decrementing on archive. Started after the Vantablack sync migration shipped on the 14th" } }], fixture: {},
  },
  "desirable-outputs/whatIsOnMyPlateToday": {
    reply: "Here is your plate today.\nCompleted: Ship invoice PDF export; Migrate billing webhooks to v2.\nDue today: Review Q4 vendor contract; Prepare board update deck.\nI cannot see meetings.",
    toolCalls: [{ name: "tasks_recent", input: {} }, { name: "tasks_read", input: {} }], fixture: {},
  },
};
