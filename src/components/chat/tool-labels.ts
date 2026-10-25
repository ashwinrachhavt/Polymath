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
