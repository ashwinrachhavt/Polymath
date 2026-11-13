import { sql } from "drizzle-orm";
import { boolean, check, index, integer, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { mutable, primaryId, tenantId } from "../../db/columns";
import { users } from "../identity/schema";
import { artifacts, documents } from "../knowledge/schema";
import { quizzes } from "../learning/schema";

/*
 * What the Polymath plugin leaves behind. An explainer is a request to explain
 * one code change: the note that explains it, the quiz that checks it, and the
 * hidden document that gives the quiz its text. The row exists from the moment
 * the request is accepted, so a coding agent can poll one id while the job
 * (generation_jobs, subject `explainer:<id>`) writes the rest; the note, the
 * document and the quiz stay null until the job gets that far.
 */
export const codeExplainers = pgTable(
  "code_explainers",
  {
    id: primaryId(),
    workspaceId: tenantId(),
    /** Whose understanding this checks: the person who minted the API key, never the key itself. */
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** The caller's intent key; a repeated request returns the first explainer. */
    requestKey: text("request_key").notNull(),
    /** `owner/name` of the repository, as the agent's git remote names it. */
    repo: text("repo").notNull(),
    commitSha: text("commit_sha").notNull(),
    /** The git range explained, or null for the working tree. */
    range: text("range"),
    artifactId: uuid("artifact_id").references(() => artifacts.id, { onDelete: "set null" }),
    /** The archived document whose text the quiz is made from; the note is the thing people open. */
    documentId: uuid("document_id").references(() => documents.id, { onDelete: "set null" }),
    quizId: uuid("quiz_id").references(() => quizzes.id, { onDelete: "set null" }),
    ...mutable,
  },
  (t) => [
    uniqueIndex("code_explainers_request_key").on(t.workspaceId, t.requestKey),
    index("code_explainers_repo_commit_idx").on(t.workspaceId, t.userId, t.repo, t.commitSha),
  ],
);

/** Per-person plugin behavior. Every switch starts off; the plugin does nothing the person did not turn on. */
export const understandingPreferences = pgTable(
  "understanding_preferences",
  {
    id: primaryId(),
    workspaceId: tenantId(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** Suggest an explainer after a large commit. */
    autoSuggest: boolean("auto_suggest").notNull().default(false),
    /** Warn, never block, before a push whose commit has no passed check. */
    pushWarning: boolean("push_warning").notNull().default(false),
    questionCount: integer("question_count").notNull().default(5),
    difficulty: text("difficulty").$type<"easier" | "standard" | "harder">().notNull().default("standard"),
    ...mutable,
  },
  (t) => [
    uniqueIndex("understanding_preferences_user_key").on(t.workspaceId, t.userId),
    check("understanding_preferences_count_check", sql`question_count between 5 and 10`),
    check("understanding_preferences_difficulty_check", sql`difficulty in ('easier', 'standard', 'harder')`),
  ],
);
