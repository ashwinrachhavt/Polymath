import { pathToFileURL } from "node:url";
import { createClient } from "../lib/client.mjs";
import { defaultExec, repoName, resolveCommit } from "../lib/git.mjs";

const BIG_COMMIT_LINES = 150;
const HOOK_TIMEOUT_MS = 3_000;
const PREFERENCES = "/api/v1/understanding/preferences";
const EXPLAINERS = "/api/v1/understanding/explainers";

function changedLines(shortstat) {
  return [...shortstat.matchAll(/(\d+) (?:insertion|deletion)/g)].reduce((sum, match) => sum + Number(match[1]), 0);
}

async function afterCommit(client, exec, cwd) {
  const lines = changedLines(await exec("git", ["diff", "--shortstat", "HEAD~1", "HEAD"], { cwd }));
  if (lines < BIG_COMMIT_LINES) return null;
  if (!(await client.get(PREFERENCES)).autoSuggest) return null;
  return {
    hookSpecificOutput: {
      hookEventName: "PostToolUse",
      additionalContext: `The commit you just made changed ${lines} lines. In one sentence, suggest that the user run /polymath:explain to get a Polymath explainer and understanding check for it. Only suggest it; do not run it.`,
    },
  };
}

async function beforePush(client, exec, cwd) {
  if (!(await client.get(PREFERENCES)).pushWarning) return null;
  const [repo, commit] = await Promise.all([repoName(exec, cwd), resolveCommit(exec, cwd, "HEAD")]);
  const { explainers } = await client.get(EXPLAINERS, { repo, commit });
  if (explainers.some((explainer) => explainer.passed)) return null;
  return {
    systemMessage: `Polymath: commit ${commit.slice(0, 7)} has no passed understanding check. Run /polymath:explain first if you want one.`,
  };
}

const HANDLERS = new Map([
  ["PostToolUse", afterCommit],
  ["PreToolUse", beforePush],
]);

/** @param {{ input: string, env?: Record<string, string | undefined>, fetch?: typeof globalThis.fetch, exec?: (file: string, args: string[], options: { cwd: string }) => Promise<string> }} options */
export async function run({ input, env = process.env, fetch, exec = defaultExec }) {
  try {
    const { hook_event_name: event, cwd = process.cwd() } = JSON.parse(input);
    const client = createClient({
      env: {
        POLYMATH_URL: env.POLYMATH_URL || env.CLAUDE_PLUGIN_OPTION_POLYMATH_URL,
        POLYMATH_API_KEY: env.POLYMATH_API_KEY || env.CLAUDE_PLUGIN_OPTION_API_KEY,
      },
      fetch,
      timeoutMs: HOOK_TIMEOUT_MS,
    });
    client.assertConfigured();
    const output = await HANDLERS.get(event)?.(client, exec, cwd);
    return output ? JSON.stringify(output) : "";
  } catch {
    return "";
  }
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  setTimeout(() => process.exit(0), HOOK_TIMEOUT_MS).unref();
  process.stdout.write(await run({ input: await readStdin() }));
}
