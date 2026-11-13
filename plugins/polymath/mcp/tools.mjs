import { createHash } from "node:crypto";
import { PolymathError } from "../lib/client.mjs";
import { repoName, resolveCommit } from "../lib/git.mjs";

const EXPLAINERS = "/api/v1/understanding/explainers";
const MAX_DIFF_CHARS = 400_000;
const DEFAULT_RANGE = "HEAD~1..HEAD";
const POLL_INTERVAL_MS = 2_000;
const POLL_TIMEOUT_MS = 150_000;
const LEVELS = ["known", "shaky", "unassessed"];

const text = (...parts) => ({ content: parts.map((part) => ({ type: "text", text: part })) });
export const failure = (message) => ({ ...text(message), isError: true });

function requireString(value, name) {
  if (typeof value !== "string" || !value.trim()) throw new PolymathError(`${name} is required.`);
  return value;
}

async function collectChange(exec, cwd, range) {
  const git = (...args) => exec("git", args, { cwd });
  if (range?.startsWith("-")) throw new PolymathError("range must be a git revision range such as main..HEAD.");
  if (!range && (await git("status", "--porcelain", "--untracked-files=no")).trim()) {
    return { range: null, diff: await git("diff", "HEAD"), commit: await resolveCommit(exec, cwd, "HEAD") };
  }
  const effective = range ?? DEFAULT_RANGE;
  const end = effective.split(/\.{2,3}/).pop() || "HEAD";
  return { range: effective, diff: await git("diff", effective, "--"), commit: await resolveCommit(exec, cwd, end) };
}

function capDiff(diff) {
  if (diff.length <= MAX_DIFF_CHARS) return diff;
  return `${diff.slice(0, MAX_DIFF_CHARS)}\n[diff truncated at ${MAX_DIFF_CHARS} characters]\n`;
}

async function waitUntilSettled({ client, sleep }, id) {
  for (let waited = 0; ; waited += POLL_INTERVAL_MS) {
    const { explainer } = await client.get(`${EXPLAINERS}/${encodeURIComponent(id)}`);
    if (explainer.status !== "pending" || waited >= POLL_TIMEOUT_MS) return explainer;
    await sleep(POLL_INTERVAL_MS);
  }
}

const nextStep = (id) => `Next: run check_understanding with explainer_id "${id}" to take the understanding check.`;
const pendingNotice = (id) => `Explainer ${id} is still generating. check_understanding with this id waits for it.`;

async function explainChange(ctx, args) {
  const summary = requireString(args.summary, "summary");
  const cwd = args.cwd ?? process.cwd();
  const [repo, change] = await Promise.all([repoName(ctx.exec, cwd), collectChange(ctx.exec, cwd, args.range)]);
  if (!change.diff.trim()) throw new PolymathError("There are no changes to explain in that range.");
  const digest = createHash("sha256")
    .update(change.range ?? "")
    .update(change.diff)
    .digest("hex")
    .slice(0, 16);
  const created = await ctx.client.post(EXPLAINERS, {
    repo,
    commit: change.commit,
    range: change.range,
    summary,
    diff: capDiff(change.diff),
    requestKey: `${repo}@${change.commit}:${digest}`,
  });
  const explainer =
    created.explainer.status === "pending" ? await waitUntilSettled(ctx, created.explainer.id) : created.explainer;
  if (explainer.status === "failed") return failure(explainer.error ?? "The explainer failed to generate.");
  if (explainer.status === "pending") return text(`Status: pending. ${pendingNotice(explainer.id)}`);
  return text(
    `Explainer ready: ${ctx.client.baseUrl}${explainer.notePath}\nExplainer id: ${explainer.id}\n${nextStep(explainer.id)}`,
  );
}

function formatQuestions(id, { questions }) {
  const lines = [
    `Understanding check for explainer ${id}, ${questions.length} questions. Ask them one at a time.`,
    `Answer each with one choice value, or null for "I don't know".`,
  ];
  questions.forEach((question, index) => {
    lines.push("", `${index + 1}. [question_id: ${question.id}] ${question.prompt}`);
    for (const choice of question.choices) lines.push(`   - value "${choice.value}": ${choice.label}`);
    lines.push(`   - value null: I don't know`);
  });
  return lines.join("\n");
}

function formatGrade(baseUrl, grade) {
  const lines = [
    `Score: ${grade.correct}/${grade.total} (pass mark ${grade.passMark}). ${grade.passed ? "Passed." : "Not passed."}`,
  ];
  grade.questions.forEach((question, index) => {
    lines.push("", `${index + 1}. ${question.correct ? "Correct" : "Missed"}: ${question.prompt}`);
    if (!question.correct) {
      lines.push(`   Your answer: ${question.yourValue ?? "I don't know"}`);
      lines.push(`   Right answer: ${question.answerLabel}`);
    }
    lines.push(`   ${question.explanation}`);
  });
  lines.push(
    "",
    `Missed concepts: ${grade.missedConcepts.length ? grade.missedConcepts.join(", ") : "none"}`,
    `Review items added to daily practice: ${grade.reviewItemsAdded}`,
  );
  if (grade.quizPath) lines.push(`Quiz: ${baseUrl}${grade.quizPath}`);
  return lines.join("\n");
}

function parseAnswers(answers) {
  if (!Array.isArray(answers)) throw new PolymathError("answers must be a list of {question_id, value}.");
  return answers.map((answer) => {
    if (typeof answer?.question_id !== "string" || !(typeof answer.value === "string" || answer.value === null)) {
      throw new PolymathError("Each answer needs a question_id string and a value that is a string or null.");
    }
    return { questionId: answer.question_id, value: answer.value };
  });
}

async function checkUnderstanding(ctx, args) {
  const id = requireString(args.explainer_id, "explainer_id");
  const check = `${EXPLAINERS}/${encodeURIComponent(id)}/check`;
  if (args.answers !== undefined) {
    const grade = await ctx.client.post(check, { answers: parseAnswers(args.answers) });
    return text(formatGrade(ctx.client.baseUrl, grade));
  }
  const explainer = await waitUntilSettled(ctx, id);
  if (explainer.status === "failed") return failure(explainer.error ?? "The explainer failed to generate.");
  if (explainer.status === "pending") return text(`Status: pending. ${pendingNotice(id)}`);
  return text(formatQuestions(id, await ctx.client.get(check)));
}

async function whatDoIKnow(ctx, args) {
  const known = await ctx.client.get("/api/v1/understanding/known", { topic: args.topic });
  const lines = [
    known.topic
      ? `Concepts the user has been tested on for "${known.topic}":`
      : "Concepts the user has been tested on:",
  ];
  for (const level of LEVELS) {
    const terms = known.concepts.filter((concept) => concept.level === level).map((concept) => concept.term);
    lines.push(`${level}: ${terms.length ? terms.join(", ") : "none"}`);
  }
  return text(lines.join("\n"), JSON.stringify(known));
}

async function capture(ctx, args) {
  if (!args.text?.trim() && !args.url) throw new PolymathError("Send text, a url, or both.");
  const body = Object.fromEntries(
    Object.entries({ text: args.text, url: args.url, title: args.title }).filter(([, value]) => value !== undefined),
  );
  try {
    await ctx.client.post("/api/v1/captures", body);
  } catch (error) {
    if (error.status === 409) return text("That is already in your Polymath inbox.");
    throw error;
  }
  return text("Saved to your Polymath inbox.");
}

export const tools = [
  {
    name: "explain_change",
    description:
      "Send a code change to Polymath and get back a literate explainer note that teaches the change. Use only when the user asks to explain or understand a change. Pass a summary of the session: what the user asked for, the decisions made, the dead ends, and what is risky, so the explainer can skip what the user already knows. The tool reads the git diff itself: the last commit by default, the uncommitted changes when the working tree is dirty, or an explicit range. Returns the note URL and an explainer id for check_understanding.",
    inputSchema: {
      type: "object",
      properties: {
        summary: {
          type: "string",
          description:
            "What the user asked for, the decisions made, dead ends hit, and what is risky about the change.",
        },
        range: {
          type: "string",
          description:
            "Git revision range such as main..HEAD or HEAD~3..HEAD. Defaults to the last commit, or to uncommitted changes when the working tree has any.",
        },
        cwd: { type: "string", description: "Path of the git repository. Defaults to the server's working directory." },
      },
      required: ["summary"],
      additionalProperties: false,
    },
    run: explainChange,
  },
  {
    name: "check_understanding",
    description:
      "Run the understanding check for a Polymath explainer. Call it with only explainer_id to wait for the explainer and get the questions with their choice values and labels; ask the user one at a time, then call it again with answers to get the score, the right answers with explanations, and the missed concepts. Missed concepts become review items in the user's daily practice. Use only after the user agreed to take the check.",
    inputSchema: {
      type: "object",
      properties: {
        explainer_id: { type: "string", description: "The explainer id returned by explain_change." },
        answers: {
          type: "array",
          description:
            "The user's answers. Omit to fetch the questions instead. A missing question counts as I don't know.",
          items: {
            type: "object",
            properties: {
              question_id: { type: "string" },
              value: { type: ["string", "null"], description: "A choice value, or null for I don't know." },
            },
            required: ["question_id", "value"],
            additionalProperties: false,
          },
        },
      },
      required: ["explainer_id"],
      additionalProperties: false,
    },
    run: checkUnderstanding,
  },
  {
    name: "what_do_i_know",
    description:
      "List the concepts Polymath has tested the user on, grouped as known, shaky, and unassessed, optionally narrowed to a topic. Call it before explaining a change so the explanation can skip what the user already knows and spend time on what is shaky or new.",
    inputSchema: {
      type: "object",
      properties: {
        topic: { type: "string", description: "Topic or area to narrow the concepts to, such as database migrations." },
      },
      additionalProperties: false,
    },
    run: whatDoIKnow,
  },
  {
    name: "capture",
    description:
      "Save text, a link, or both into the user's Polymath inbox for later. Use only when the user asks to save or capture something. Provide text, url, or both. A duplicate link is reported as already in the inbox.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "The note or excerpt to save." },
        url: { type: "string", description: "A link to save." },
        title: { type: "string", description: "Optional title for the capture." },
      },
      additionalProperties: false,
    },
    run: capture,
  },
];
