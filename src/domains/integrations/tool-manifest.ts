import { z } from "zod";
import { PROVIDER_TOOLS } from "./capabilities";

/*
 * The input contract for every provider tool, in one place, so the manifest a
 * model reads and the arguments the gateway parses cannot disagree. Task 6
 * parses with these same schemas; `tools/list` publishes them as JSON Schema.
 *
 * Descriptions are written for a model choosing a tool: what it returns, and
 * what it will never do.
 */

const searchArguments = z.object({
  query: z.string().min(1).describe("Gmail search query, same syntax as the Gmail search box."),
  limit: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .describe("Maximum messages to return (default 25, maximum 100)."),
  accountAlias: z.string().optional().describe("Which connected Gmail account, e.g. work-gmail."),
});

const readThreadArguments = z.object({
  threadId: z.string().min(1).describe("Gmail thread id, as returned by gmail_search."),
  accountAlias: z.string().optional().describe("Which connected Gmail account, e.g. work-gmail."),
});

const sendArguments = z.object({
  to: z.string().describe("Recipient address."),
  subject: z.string(),
  body: z.string(),
  messageId: z.string().describe("Provider message id this replies to, for dedupe."),
  accountAlias: z.string().optional().describe("Which connected Gmail account, e.g. work-gmail."),
});

/*
 * Keyed by tool name, and typed against PROVIDER_TOOLS so a tool renamed in the
 * catalog fails to compile here instead of disappearing from the manifest.
 */
export const TOOL_SCHEMAS = {
  gmail_search: searchArguments,
  gmail_read_thread: readThreadArguments,
  gmail_send: sendArguments,
} satisfies Record<keyof typeof PROVIDER_TOOLS, z.ZodType>;

export const TOOL_DESCRIPTIONS: Record<keyof typeof PROVIDER_TOOLS, string> = {
  gmail_search: "Search the owner's connected Gmail and return message summaries. Read-only.",
  gmail_read_thread:
    "Read one Gmail thread, including plain-text bodies, from the owner's connected account. Read-only.",
  gmail_send:
    "Propose sending an email. Creates a reviewable proposal for the owner; it does not send.",
};

/** The MCP `tools/list` manifest: every provider tool, its description, and its input schema. */
export function toolManifest() {
  return (Object.keys(PROVIDER_TOOLS) as Array<keyof typeof PROVIDER_TOOLS>).map((name) => ({
    name,
    description: TOOL_DESCRIPTIONS[name],
    // MCP declares JSON Schema 2020-12, which zod emits natively.
    inputSchema: z.toJSONSchema(TOOL_SCHEMAS[name], { io: "input" }),
  }));
}
