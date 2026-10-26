/*
 * Tool label vocabulary, shared by the tool pills and any surface that names
 * a tool call. Internal lookups with nothing to say (a registry search, a
 * self-check) are filtered out of the transcript entirely.
 */

export const INTERNAL_TOOLS = /^(eve__|search_models|search_registry|notebook_open)/;

const TOOL_LABELS: Array<[RegExp, string]> = [
  [/tasks_recent/i, "Checked completed tasks"],
  [/tasks_read|tasks\./i, "Checked open tasks"],
  [/documents_search|documents\./i, "Searched your documents"],
  [/wiki_read|wiki\./i, "Checked the wiki"],
  [/wiki_ingest/i, "Updated the wiki"],
  [/wiki_lint/i, "Wiki health check"],
  [/gmail_read_thread/i, "Read the thread"],
  [/gmail/i, "Searched your mail"],
  [/calendar/i, "Checked calendar"],
  [/web_search/i, "Searched the web"],
  [/web_fetch/i, "Read a web page"],
  // Specific first: /drive/ below also matches googledrive_search_files, and
  // the /gmail/ entry above also matches gmail_read_thread.
  [/googledocs_search/i, "Searched your Google Docs"],
  [/googlesheets/i, "Listed your spreadsheets"],
  [/googledrive_search|drive_search/i, "Searched your Drive files"],
  [/drive|files_list|list_files/i, "Listed your Drive files"],
];

export const toolLabel = (raw: string) => TOOL_LABELS.find(([re]) => re.test(raw))?.[1] ?? raw.replace(/_/g, " ");

/*
 * One line on what each capability does, for the agent panel's tool list. A
 * capability the run's snapshot allows but this table has never seen falls back
 * to its label: the panel names what it can and never guesses at the rest.
 */
const TOOL_DESCRIPTIONS: Array<[RegExp, string]> = [
  [/tasks_recent|tasks_read|tasks\./i, "Reads the owner's task list."],
  [/documents_search|documents\./i, "Searches the document library and returns cited passages."],
  [/wiki_read|wiki\./i, "Reads pages in the workspace wiki."],
  [/wiki_ingest/i, "Adds or updates a wiki page."],
  [/wiki_lint/i, "Checks the wiki for broken links and gaps."],
  [/gmail/i, "Reads mail the owner has connected."],
  [/calendar/i, "Reads the owner's calendar."],
  [/web_search/i, "Searches the public web."],
  [/web_fetch/i, "Fetches and reads one web page."],
  [/drive|files_list|list_files/i, "Lists files in the owner's connected drive."],
];

export const toolDescription = (raw: string) => TOOL_DESCRIPTIONS.find(([re]) => re.test(raw))?.[1] ?? null;
