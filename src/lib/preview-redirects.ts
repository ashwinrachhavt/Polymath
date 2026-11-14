/*
 * The browser-local preview tools that lived under /apps/<product>/<screen>
 * are retired. Each old address lands on the real screen that does the same
 * job; an address with no counterpart, or one that never existed, lands on
 * /polymath. Only parameters the destination reads with the same meaning are
 * carried across: the notebook's ?id= (a Notes deep link), a task's ?task=
 * and a calendar day's ?date= on Work, and a canvas's ?canvasId=. Preview
 * record ids for everything else named browser-local rows that no real
 * screen can open, so they drop.
 */

type Query = Record<string, string | string[] | undefined>;

const fallback = "/polymath";

const screens: Record<string, Record<string, string>> = {
  "command-center": {
    "": "/neuralflow/work?view=today",
    briefing: "/neuralflow/work?view=today",
    inbox: "/command-center/inbox",
    work: "/neuralflow/work",
    contacts: "/command-center/relationships/people",
    companies: "/command-center/relationships/companies",
    opportunities: "/command-center/relationships/people",
    applications: "/command-center/relationships/people",
    documents: "/polymath/knowledge",
    writing: "/polymath/notes",
    spaces: "/projects",
    agents: "/reviews",
    conversations: "/command-center/conversations",
    memory: "/settings",
    reviews: "/reviews",
    spending: "/command-center/spending",
    companion: "/settings",
    integrations: "/command-center/integrations",
    activity: "/activity",
    settings: "/settings",
  },
  neuralflow: {
    "": "/neuralflow/overview",
    dashboard: "/neuralflow/overview",
    tasks: "/neuralflow/work",
    boards: "/neuralflow/work?view=board",
    calendar: "/neuralflow/work?view=calendar",
    scheduler: "/neuralflow/work?view=calendar",
    meetings: "/neuralflow/work?view=calendar",
    focus: "/neuralflow/focus",
    "brain-dump": "/command-center/inbox",
    reports: "/neuralflow/reports",
    rewards: "/learn/stones",
    projects: "/projects",
    notes: "/polymath/notes",
  },
  polymath: {
    "": "/polymath",
    dashboard: "/polymath",
    files: "/polymath/knowledge",
    library: "/polymath/knowledge",
    zettels: "/polymath/ideas",
    dictionary: "/polymath/ideas",
    dossiers: "/projects",
    projects: "/projects",
    notebook: "/polymath/notes",
    blogs: "/polymath/notes",
    graph: "/polymath/graph",
    studio: "/artifacts",
    canvas: "/artifacts",
    research: "/polymath",
    chat: "/polymath",
    integrations: "/command-center/integrations",
  },
};

function single(query: Query, key: string): string | undefined {
  const value = query[key];
  return typeof value === "string" && value ? value : undefined;
}

function withParam(href: string, key: string, value: string | undefined) {
  if (!value) return href;
  return `${href}${href.includes("?") ? "&" : "?"}${key}=${encodeURIComponent(value)}`;
}

export function previewRedirectTarget(path: readonly string[], query: Query): string {
  const [product = "", screen = "", ...rest] = path;
  // /apps/<product>/<screen> was the deepest preview address; anything longer never existed.
  if (rest.length) return fallback;
  const target =
    Object.hasOwn(screens, product) && Object.hasOwn(screens[product], screen) ? screens[product][screen] : undefined;
  if (!target) return fallback;
  if (product === "polymath" && screen === "notebook") return withParam(target, "id", single(query, "id"));
  if (product === "polymath" && screen === "canvas") {
    const canvasId = single(query, "canvasId");
    return canvasId ? `/polymath/canvas/${encodeURIComponent(canvasId)}` : target;
  }
  if (product === "neuralflow" && screen === "tasks") return withParam(target, "task", single(query, "task"));
  if (product === "neuralflow" && screen === "calendar") return withParam(target, "date", single(query, "date"));
  return target;
}
