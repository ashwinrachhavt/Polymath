import type { WorkspaceState } from "./types";

const at = "2026-10-11T09:00:00.000Z";
export const sampleState: WorkspaceState = {
  tasks: [
    { id: "task-architecture", title: "Review the canonical Axiom data model", status: "IN_PROGRESS", priority: "High", projectId: "project-axiom", dueDate: "2026-10-11", estimate: 50, description: "Keep tasks independent of boards. Link notes to many records. Review pgvector dimensions before migration.", tags: ["Architecture", "Deep work"], rank: 1, version: 1, attachments: [{ id: "attachment-model", kind: "url", label: "Canonical schema notes", value: "https://example.test/axiom-schema", addedAt: at }] },
    { id: "task-parity", title: "Map the three donor products", status: "READY", priority: "High", projectId: "project-axiom", dueDate: "2026-10-11", estimate: 25, description: "Compare implemented screens with the PRD. Separate source evidence from future plans.", tags: ["Research"], rank: 1, version: 1 },
    { id: "task-followup", title: "Prepare a follow-up for Morgan", status: "WAITING", priority: "Medium", projectId: "project-career", estimate: 15, description: "Waiting on feedback. Draft locally; review the exact payload before sending.", tags: ["Follow up"], rank: 1, version: 1 },
    { id: "task-notes", title: "Turn research notes into atomic zettels", status: "BACKLOG", priority: "Medium", projectId: "project-learning", estimate: 25, description: "One idea per card, with evidence and links back to the source.", tags: ["Learning"], rank: 1, version: 1 },
    { id: "task-calendar", title: "Protect an afternoon focus block", status: "READY", priority: "Low", estimate: 10, description: "Create a local work block. Provider calendar writes need review.", tags: ["Planning"], rank: 2, dueDate: "2026-10-11", recurrence: { frequency: "weekly", interval: 5 }, version: 1 },
    { id: "task-shell", title: "Define the shared app shell", status: "DONE", priority: "High", projectId: "project-axiom", estimate: 25, description: "One workspace, three product lenses, shared capture and reviews.", tags: ["Design"], rank: 1, completedAt: at, version: 1 },
  ],
  artifacts: [
    { id: "note-axiom", title: "One record, many views", kind: "note", body: "Axiom is one workspace, not three disconnected backends.\n\nA task is a commitment. Boards, lists, calendars and focus sessions are views over the same record.\n\nA note can stand alone and link to tasks, dossiers or projects.\n\nOpen question: which workflow adapter should own durable agent execution?", tags: ["Architecture", "Axiom"], links: ["task-architecture", "source-spec"], version: 1, updatedAt: at },
    { id: "note-research", title: "Research log", kind: "note", body: "Research should begin with a bounded question and a source budget.\n\nKeep original sources intact. Every generated claim should point to a source span.\n\nNext: collect evidence for the donor parity matrix.", tags: ["Research"], links: ["dossier-axiom"], version: 1, updatedAt: at },
    { id: "source-spec", title: "Axiom product principles", kind: "source", body: "Briefing before browsing. Objects before pages. One record, many views. AI proposes; policy disposes. No invisible work. Learning follows completion.\n\nExternal writes require a payload preview, risk classification, captured revision, dedupe key and approval. Unknown provider outcomes reconcile before retry.", tags: ["Primary source", "Product"], links: [], version: 1, updatedAt: at },
    { id: "doc-design", title: "Design system reference", kind: "document", body: "Sample extracted text, not an uploaded original.\n\nThe interface uses cool neutral surfaces, readable type, precise borders, accessible controls and a restrained product accent. Shell navigation is shared. Each product adds its own working context.", tags: ["Design", "Classified"], links: ["note-axiom"], version: 1, updatedAt: at },
    { id: "zettel-canonical", title: "A board is a view, not a task owner", kind: "zettel", body: "Requiring a board to create a task adds friction to capture. Canonical tasks should exist independently; a saved board selects and orders them.", tags: ["Data model"], links: ["source-spec", "note-axiom"], version: 1, updatedAt: at },
    { id: "zettel-review", title: "Approval belongs to an exact revision", kind: "zettel", body: "A reviewed action is safe only when the approved revision matches the payload that executes. Editing a payload invalidates prior approval.", tags: ["Safety"], links: ["source-spec"], version: 1, updatedAt: at },
    { id: "dossier-axiom", title: "Axiom consolidation", kind: "dossier", body: "Which donor capabilities belong in each of the three product lenses?\n\nScope: operational CRM, execution and grounded knowledge.\n\nSources are pinned for this local preview; generation is not connected.", tags: ["Active", "Product research"], links: ["source-spec", "doc-design", "zettel-canonical"], version: 1, updatedAt: at },
  ],
  artifactVersions: [],
  captures: [
    { id: "capture-1", text: "Compare the board ownership constraints before migrating tasks", kind: "text", status: "UNPROCESSED", createdAt: at },
    { id: "capture-2", text: "An idea: let notes link to more than one project or task", kind: "text", status: "UNPROCESSED", createdAt: at },
  ],
  contacts: [
    { id: "contact-1", name: "Morgan Chen", email: "morgan@example.test", company: "Northstar Labs", role: "Engineering lead", status: "Follow up", notes: "Fictional sample contact. Discussed systems engineering and a follow-up research brief." },
    { id: "contact-2", name: "Alex Rivera", email: "alex@example.test", company: "Meridian Studio", role: "Product designer", status: "Active", notes: "Fictional sample contact. Interested in calm, high-density product interfaces." },
    { id: "contact-3", name: "Sam Taylor", email: "sam@example.test", company: "Northstar Labs", role: "Researcher", status: "New", notes: "Fictional sample contact. Add evidenced observations, not unsupported profile claims." },
  ],
  companies: [
    { id: "company-1", name: "Northstar Labs", industry: "Developer tools", domain: "northstar.example.test", notes: "Fictional sample organization." },
    { id: "company-2", name: "Meridian Studio", industry: "Product design", domain: "meridian.example.test", notes: "Fictional sample organization." },
  ],
  opportunities: [
    { id: "opportunity-1", title: "Senior systems engineer", company: "Northstar Labs", stage: "Preparing", value: "Role", notes: "Sample opportunity. Prepare materials without submitting an application." },
    { id: "opportunity-2", title: "Product collaboration", company: "Meridian Studio", stage: "Saved", value: "Partnership", notes: "Sample opportunity. Clarify scope before outreach." },
  ],
  reviews: [
    { id: "review-1", title: "Follow-up draft for Morgan", kind: "Email", risk: "External write", status: "Pending", payload: "To: morgan@example.test\nSubject: Following up on our conversation\n\nThanks for the discussion. I have prepared a short systems research brief and would welcome your feedback.\n\nThis is sample content. No email will be sent from this preview.", revision: 1 },
    { id: "review-2", title: "Proposed afternoon focus block", kind: "Calendar", risk: "External write", status: "Pending", payload: "Calendar: Not connected\nTitle: Axiom architecture review\nDuration: 50 minutes\nTime: Not scheduled\n\nApprove locally to rehearse the review flow. This preview cannot create provider events.", revision: 1 },
  ],
  projects: [
    { id: "project-axiom", title: "Build Axiom", description: "Consolidate three products into one trusted workspace.", status: "Active" },
    { id: "project-learning", title: "Systems learning", description: "Connect source reading, knowledge cards and deliberate practice.", status: "Active" },
    { id: "project-career", title: "Career pipeline", description: "Prepare opportunities and maintain relationships.", status: "Active" },
  ],
  events: [
    { id: "event-1", title: "Architecture focus block", date: "2026-10-11", start: "09:00", duration: 50, taskId: "task-architecture", provider: "local" },
    { id: "event-2", title: "Research and source review", date: "2026-10-11", start: "14:00", duration: 25, taskId: "task-parity", provider: "local" },
  ],
  focus: null,
  rewards: [],
  preferences: { celebrations: true, reducedMotion: false, killSwitch: true, timezone: "America/Los_Angeles", weekStart: "Monday", scheduler: { workStartHour: 9, workEndHour: 18, weekdays: [1, 2, 3, 4, 5], suggestionsEnabled: true, eveningEnabled: false, eveningStartHour: 19, eveningTitle: "Vibe coding", topics: ["Research", "Engineering"] } },
  activity: [{ id: "activity-sample", title: "Sample workspace opened", detail: "All records are fictional. Changes stay in this browser, not Neon.", at }],
};
sampleState.artifactVersions = sampleState.artifacts.map((a) => ({ id: `version-${a.id}-1`, artifactId: a.id, version: a.version, title: a.title, body: a.body, links: [...a.links], tags: [...a.tags], createdAt: a.updatedAt }));
